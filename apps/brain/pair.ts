// pair.ts — pairing a machine with a code (ADR 0014, G4). The machine asks for a pairing with no credential and
// shows a short code; the person, signed in on the web app, types it; the machine's next poll gets a personal token
// of that account named after the machine, once. The code is eight characters of Crockford base32 (shown XXXX-XXXX,
// ten minutes, one use); the machine's secret is 32 random bytes only it holds. Both are stored as their SHA-256.
// The token is made at the poll that hands it over, not at the claim, so it never sits in the database: only the
// account that claimed is kept until then. Five wrong codes in a row lock an account's claiming for fifteen minutes.
//
// A server pairs the same way (ADR 0013, F2), with its X25519 public key in the request: the preview shows the key's
// fingerprint (the owner compares it with the one in the container's log), the claim may carry the vault key sealed
// to that key by the owner's console (seal.ts: the service keeps it, opaque, and cannot open it), and the poll hands
// over a `node` token with the box, once. The box goes with the row: at that poll, or at expiry.

import type { DatabaseSync } from "node:sqlite";
import type { Auth } from "./auth.ts";
import type { Users } from "./users.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { nodeNameOf } from "../../shared/mcp/lib/nodes.ts";
import { cleanPublicKey, cleanSealed, keyFingerprint, type Sealed } from "../../shared/mcp/lib/seal.ts";

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
  | { state: "done"; token: string; url: string; sealed?: Sealed };

/** What the person sees before saying yes: which machine asks, and, for a server, its key's fingerprint, its public
 *  key and the pairing's id (what the console seals the vault key to; the id is the poll secret's hash, not it). */
export interface Preview {
  node: string;
  platform: string;
  asked: string;
  kind?: "server";
  key?: string;
  publicKey?: string;
  id?: string;
}

/** What the confirming claim may carry: the scope asked for, and the sealed vault key. */
export interface ClaimOptions {
  scope?: unknown;
  sealed?: unknown;
}

export class Pairings {
  constructor(
    private db: DatabaseSync,
    private auth: Pick<Auth, "createPersonal">,
    private users: Pick<Users, "get">,
    private url: string,
    private now: () => number = Date.now,
  ) {}

  /** A pairing for a machine: its code (to show) and its secret (to poll with). */
  async create(
    name: unknown,
    platform: unknown,
    key?: unknown,
  ): Promise<{ code: string; pairing: string; expires: string }> {
    const clean = (v: unknown, n: number) =>
      typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").trim().slice(0, n) : "";
    const label = clean(name, 60);
    if (!label) throw new PairError("name is the machine's name");
    const pub = key === undefined || key === null ? null : cleanPublicKey(key);
    if (key !== undefined && key !== null && !pub) {
      throw new PairError("key is a server's X25519 public key, base64url");
    }
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
      this.db.prepare("insert into pairings (code, secret, name, platform, expires, key) values (?, ?, ?, ?, ?, ?)")
        .run(hash, await sha256(pairing), label, clean(platform, 20), expires, pub);
      return { code: showCode(code), pairing, expires: new Date(expires).toISOString() };
    }
    throw new PairError("no free code: try again", 503);
  }

  /** What the machine learns by polling: waiting, or (once) its token. */
  async poll(pairing: string): Promise<Polled> {
    const hash = await sha256(pairing);
    const row = this.db.prepare("select name, expires, user, key, sealed, scope from pairings where secret = ?").get(
      hash,
    ) as
      | {
        name: string;
        expires: number;
        user: string | null;
        key: string | null;
        sealed: string | null;
        scope: string | null;
      }
      | undefined;
    if (!row || row.expires < this.now()) return { state: "expired" };
    if (!row.user) return { state: "waiting" };
    // taken before anything is awaited, so two polls cannot both get the token
    if (!Number(this.db.prepare("delete from pairings where secret = ?").run(hash).changes)) {
      return { state: "expired" };
    }
    const u = this.users.get(row.user);
    if (!u || u.disabled) return { state: "expired" };
    // a server's pairing makes a node token, whatever the claim said; a desktop's a machine token, as before F2
    const scope = row.key ? "node" : "machine";
    const token = await this.auth.createPersonal(row.user, nodeNameOf(row.name), scope);
    const sealed = row.sealed ? cleanSealed(JSON.parse(row.sealed)) : null;
    return { state: "done", token, url: this.url, ...(sealed ? { sealed } : {}) };
  }

  /** Whether an account's claiming is locked: five wrong codes in the last fifteen minutes. */
  locked(user: string): boolean {
    const now = this.now();
    this.db.prepare("delete from pair_failures where at < ?").run(now - LOCK_MS);
    return (this.db.prepare("select count(*) n from pair_failures where user = ?").get(user) as { n: number }).n >=
      MAX_WRONG;
  }

  /** The signed-in account types the code. Without `confirm` it only learns which machine asks (its name, platform
   *  and when it asked), so that a code someone else handed over cannot make their machine the person's node
   *  unseen; with `confirm` the machine is its own from now on. A wrong code counts either way. */
  async claim(
    user: string,
    typed: unknown,
    confirm = false,
    opts: ClaimOptions = {},
  ): Promise<{ node: string; kind?: "server" } | { preview: Preview }> {
    if (this.locked(user)) throw new PairError("too many wrong codes: try again in a quarter of an hour", 429);
    const code = normalCode(typed);
    const row = code
      ? this.db.prepare("select name, platform, expires, user, key, secret from pairings where code = ?").get(
        await sha256(code),
      ) as
        | { name: string; platform: string; expires: number; user: string | null; key: string | null; secret: string }
        | undefined
      : undefined;
    if (!code || !row || row.expires < this.now() || row.user) {
      this.db.prepare("insert into pair_failures (user, at) values (?, ?)").run(user, this.now());
      throw new PairError("unknown or expired code", 404);
    }
    if (!confirm) {
      const asked = new Date(row.expires - PAIR_TTL_MS).toISOString();
      const server = row.key
        ? { kind: "server" as const, key: await keyFingerprint(row.key), publicKey: row.key, id: row.secret }
        : {};
      return { preview: { node: nodeNameOf(row.name), platform: row.platform, asked, ...server } };
    }
    // a server's pairing is a node's, never more; a desktop's carries no sealed key and asks for no other scope
    const scope = opts.scope ?? (row.key ? "node" : "machine");
    if (scope !== (row.key ? "node" : "machine")) {
      throw new PairError(row.key ? "a server pairs with scope node" : "a desktop pairs with scope machine");
    }
    let sealed: string | null = null;
    if (opts.sealed !== undefined && opts.sealed !== null) {
      if (!row.key) throw new PairError("only a server's pairing carries a sealed vault key");
      const box = cleanSealed(opts.sealed);
      if (!box) throw new PairError("sealed is not a sealed vault key");
      sealed = JSON.stringify(box);
    }
    this.db.prepare("update pairings set user = ?, sealed = ?, scope = ? where code = ?").run(
      user,
      sealed,
      scope as string,
      await sha256(code),
    );
    this.db.prepare("delete from pair_failures where user = ?").run(user);
    return { node: nodeNameOf(row.name), ...(row.key ? { kind: "server" as const } : {}) };
  }
}
