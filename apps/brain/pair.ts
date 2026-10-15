// pair.ts — pairing a machine with a code (ADR 0014, G4). The machine asks for a pairing with no credential and
// shows a short code; the person, signed in on the web app, types it; the machine's next poll gets a personal token
// of that account named after the machine, once. The code is eight characters of Crockford base32 (shown XXXX-XXXX,
// ten minutes, one use); the machine's secret is 32 random bytes only it holds. Both are stored as their SHA-256.
// The token is made at the poll that hands it over, not at the claim, so it never sits in the database: only the
// account that claimed is kept until then. Five wrong codes in a row lock an account's claiming for fifteen minutes.

import type { DatabaseSync } from "node:sqlite";
import type { Auth } from "./auth.ts";
import type { Users } from "./users.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { nodeNameOf } from "../../shared/mcp/lib/nodes.ts";

export const PAIR_TTL_MS = 10 * 60_000;
export const LOCK_MS = 15 * 60_000;
export const MAX_WRONG = 5;
/** Pairings waiting at once, for everyone: the route has no credential, so the table is bounded. */
export const MAX_OPEN = 500;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A fresh code: eight characters of Crockford base32 from the system's random numbers (256 is a multiple of 32,
 *  so every character is equally likely). */
export function newCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => ALPHABET[b & 31]).join("");
}

/** Pure: a code as it is shown, XXXX-XXXX. */
export const showCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Pure: what a person typed as the code it stands for, or null when it cannot be one. Case, dashes and spaces
 *  do not matter, and Crockford's look-alikes read as the digits (O is 0, I and L are 1). */
export function normalCode(typed: unknown): string | null {
  if (typeof typed !== "string" || typed.length > 40) return null;
  const s = typed.toUpperCase().replace(/[\s-]+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return s.length === 8 && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

export class PairError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type Polled =
  | { state: "waiting" }
  | { state: "expired" }
  | { state: "done"; token: string; url: string };

export class Pairings {
  constructor(
    private db: DatabaseSync,
    private auth: Pick<Auth, "createPersonal">,
    private users: Pick<Users, "get">,
    private url: string,
    private now: () => number = Date.now,
  ) {}

  /** A pairing for a machine: its code (to show) and its secret (to poll with). */
  async create(name: unknown, platform: unknown): Promise<{ code: string; pairing: string; expires: string }> {
    const clean = (v: unknown, n: number) =>
      typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").trim().slice(0, n) : "";
    const label = clean(name, 60);
    if (!label) throw new PairError("name is the machine's name");
    const now = this.now();
    this.db.prepare("delete from pairings where expires < ?").run(now);
    if ((this.db.prepare("select count(*) n from pairings").get() as { n: number }).n >= MAX_OPEN) {
      throw new PairError("too many pairings waiting: try again in a few minutes", 503);
    }
    const pairing = randomToken(32);
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const hash = await sha256(code);
      if (this.db.prepare("select 1 from pairings where code = ?").get(hash)) continue;
      const expires = now + PAIR_TTL_MS;
      this.db.prepare("insert into pairings (code, secret, name, platform, expires) values (?, ?, ?, ?, ?)").run(
        hash,
        await sha256(pairing),
        label,
        clean(platform, 20),
        expires,
      );
      return { code: showCode(code), pairing, expires: new Date(expires).toISOString() };
    }
    throw new PairError("no free code: try again", 503);
  }

  /** What the machine learns by polling: waiting, or (once) its token. */
  async poll(pairing: string): Promise<Polled> {
    const hash = await sha256(pairing);
    const row = this.db.prepare("select name, expires, user from pairings where secret = ?").get(hash) as
      | { name: string; expires: number; user: string | null }
      | undefined;
    if (!row || row.expires < this.now()) return { state: "expired" };
    if (!row.user) return { state: "waiting" };
    // taken before anything is awaited, so two polls cannot both get the token
    if (!Number(this.db.prepare("delete from pairings where secret = ?").run(hash).changes)) {
      return { state: "expired" };
    }
    const u = this.users.get(row.user);
    if (!u || u.disabled) return { state: "expired" };
    return { state: "done", token: await this.auth.createPersonal(row.user, nodeNameOf(row.name)), url: this.url };
  }

  /** Whether an account's claiming is locked: five wrong codes in the last fifteen minutes. */
  locked(user: string): boolean {
    const now = this.now();
    this.db.prepare("delete from pair_failures where at < ?").run(now - LOCK_MS);
    return (this.db.prepare("select count(*) n from pair_failures where user = ?").get(user) as { n: number }).n >=
      MAX_WRONG;
  }

  /** The signed-in account types the code: the machine is its own from now on; returns the node's name. */
  async claim(user: string, typed: unknown): Promise<{ node: string }> {
    if (this.locked(user)) throw new PairError("too many wrong codes: try again in a quarter of an hour", 429);
    const code = normalCode(typed);
    const row = code
      ? this.db.prepare("select name, expires, user from pairings where code = ?").get(await sha256(code)) as
        | { name: string; expires: number; user: string | null }
        | undefined
      : undefined;
    if (!code || !row || row.expires < this.now() || row.user) {
      this.db.prepare("insert into pair_failures (user, at) values (?, ?)").run(user, this.now());
      throw new PairError("unknown or expired code", 404);
    }
    this.db.prepare("update pairings set user = ? where code = ?").run(user, await sha256(code));
    this.db.prepare("delete from pair_failures where user = ?").run(user);
    return { node: nodeNameOf(row.name) };
  }
}
