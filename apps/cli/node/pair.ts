// pair.ts — pairing this machine with a code (ADR 0014, G4): `agents node pair` and the console's «Pair with a code».
// The machine asks the service for a pairing (no credential), shows the short code, and polls with the secret only it
// holds until the person has typed the code in the web app's Machines page; the answer carries the node's own token,
// once. Nothing here listens: it is outbound HTTPS, as every node call is.
//
// A server, unconfigured, pairs the same way from its container's log (ADR 0013, F2): `agents node pair --server`
// makes an X25519 key pair (`<state>/pair-key`, 0600), asks with its public half, prints the code and the key's
// fingerprint, and asks again when a code expires. The owner types the code in their console, compares the
// fingerprint and confirms; the poll then brings the node's token and, when the console sealed it, the vault key,
// which only this key opens. The key pair is removed once it has served.

import { ANSI } from "../lib/output.ts";
import { STATE } from "../lib/paths.ts";
import { readJson, writeAtomic } from "../lib/fs.ts";
import { keyFingerprint, newPairKey, openSealed, type PairKey, type Sealed } from "../../../shared/mcp/lib/seal.ts";
import {
  importKey,
  keyMatches,
  pairVault,
  recoveryCode,
  vaultDir,
  vaultKeyFile,
} from "../../../shared/mcp/lib/vault.ts";

/** What the service answers a new pairing with. */
export interface Pairing {
  code: string;
  pairing: string;
  expires: string;
}

type Polled =
  | { state: "waiting" }
  | { state: "expired" }
  | { state: "done"; token: string; url?: string; sealed?: Sealed };

export interface PairIO {
  fetcher?: typeof fetch;
  /** the code is up: show it (a server's pairing adds its key's fingerprint) */
  show: (p: { code: string; url: string; expires: string; fingerprint?: string }) => void;
  /** a tick while it waits (a spinner) */
  tick?: (waitedMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** how often the service is asked */
  everyMs?: number;
  /** a server's pairing: its X25519 public key (base64url) */
  key?: string;
}

/** The token; for a server's pairing also the pairing's id (what the vault key was sealed for) and the box. */
export type PairResult =
  | { ok: true; token: string; id?: string; sealed?: Sealed }
  | { ok: false; message: string; expired?: boolean };

/** Pure: where the person types the code: the web app's Machines page. */
export const machinesUrl = (base: string): string => `${base.replace(/\/+$/, "")}/app#/machines`;

/** Pure: the code spaced out for reading from across a desk: `A B C D - 2 3 4 5`, bold. */
export function bigCode(code: string): string {
  return `${ANSI.b}${[...code].join(" ")}${ANSI.x}`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Pure: one frame of the waiting spinner. */
export const spinnerFrame = (waitedMs: number, every = 120): string =>
  SPINNER[Math.floor(waitedMs / every) % SPINNER.length];

const failure = async (r: Response, what: string): Promise<string> => {
  const e = await r.json().catch(() => ({})) as { error?: string };
  return `${what}: ${e.error ?? `HTTP ${r.status}`}`;
};

/** Asks the service for a pairing and waits for the person to claim it: the token, or why not (the code expired, the
 *  service said no, the wait was cancelled). A poll that fails on the network is tried again until the code expires. */
export async function pairMachine(
  base: string,
  name: string,
  platform: string,
  io: PairIO,
): Promise<PairResult> {
  const fetcher = io.fetcher ?? fetch;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const root = base.replace(/\/+$/, "");
  let p: Pairing;
  try {
    const r = await fetcher(`${root}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, platform, ...(io.key ? { key: io.key } : {}) }),
      signal: io.signal ? AbortSignal.any([io.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, message: await failure(r, `${root} would not start a pairing`) };
    p = await r.json() as Pairing;
    if (typeof p.code !== "string" || typeof p.pairing !== "string") throw new Error("not a pairing");
  } catch (e) {
    return { ok: false, message: `could not reach ${root}: ${(e as Error).message}` };
  }
  io.show({ code: p.code, url: machinesUrl(root), expires: p.expires });
  const began = now();
  // a little past the code's life, so the service has the last word on whether it expired
  const until = (Date.parse(p.expires) || began + 10 * 60_000) + 15_000;
  const every = io.everyMs ?? 2_000;
  while (!io.signal?.aborted && now() < until) {
    await sleep(every);
    io.tick?.(now() - began);
    try {
      const r = await fetcher(`${root}/api/pair/${encodeURIComponent(p.pairing)}`, {
        signal: io.signal ? AbortSignal.any([io.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        // too many requests (429) or a service hiccup: wait and ask again; anything else will not get better
        if (r.status === 429 || r.status >= 500) {
          await r.body?.cancel();
          continue;
        }
        return { ok: false, message: await failure(r, "the service refused the pairing") };
      }
      const d = await r.json() as Polled;
      if (d.state === "done" && typeof d.token === "string" && d.token) {
        if (!io.key) return { ok: true, token: d.token };
        return { ok: true, token: d.token, id: await pairingId(p.pairing), ...(d.sealed ? { sealed: d.sealed } : {}) };
      }
      if (d.state === "expired") {
        return { ok: false, expired: true, message: "the code expired before it was typed: run it again" };
      }
    } catch { /* a network error: ask again until the code expires */ }
  }
  if (io.signal?.aborted) return { ok: false, message: "cancelled" };
  return { ok: false, expired: true, message: "the code expired before it was typed: run it again" };
}

// ---------------------------------------------------------------- a server's pairing (ADR 0013, F2)

/** Pure-ish: the pairing's id the service shows the console: the SHA-256 of the poll secret, base64url. */
export async function pairingId(secret: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
  return btoa(String.fromCharCode(...h)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Where a server keeps its pairing key pair until it has paired: this machine only, the user's alone. */
export const pairKeyFile = (): string => `${STATE}/pair-key`;

/** The server's pairing key pair: the one it made before (a restart shows the same fingerprint), else a new one. */
export async function loadPairKey(file = pairKeyFile()): Promise<PairKey> {
  const k = await readJson<PairKey>(file);
  if (k?.kty === "OKP" && k.crv === "X25519" && typeof k.d === "string" && typeof k.x === "string") return k;
  const fresh = await newPairKey();
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true, mode: 0o700 });
  await writeAtomic(file, JSON.stringify(fresh) + "\n", { mode: 0o600 });
  return fresh;
}

/** Pure: the lines a server prints in its log for the owner: the code, the fingerprint to compare, where. */
export function serverPairLines(p: { code: string; fingerprint: string; service: string; expires: string }): string[] {
  return [
    "This server is not set up. Pair it from your console: Connections › Add a server, with",
    `  code         ${p.code}`,
    `  fingerprint  ${p.fingerprint}   (the console shows it too: say yes only if they match)`,
    `  service      ${p.service}`,
    `  until        ${p.expires} (a new code follows)`,
  ];
}

/** Asks for codes, one after another as each expires, until the owner has paired this server or it is stopped. */
export async function pairServer(base: string, name: string, platform: string, key: PairKey, io: PairIO) {
  const fingerprint = await keyFingerprint(key.x);
  for (;;) {
    const r = await pairMachine(base, name, platform, {
      ...io,
      key: key.x,
      show: (p) => io.show({ ...p, fingerprint }),
    });
    if (r.ok || !r.expired || io.signal?.aborted) return r;
  }
}

/** The vault key the console sealed, opened with this server's key and kept as a server keeps it: in the key file,
 *  the user's alone. Checked against the vault when the vault is already here; when it is still on its way
 *  (Syncthing), kept as it is, and `agents node setup` finds out whether it opens it. */
export async function adoptVaultKey(sealed: Sealed, key: PairKey, id: string): Promise<"checked" | "kept"> {
  const raw = await openSealed(sealed, key, id);
  if (raw.length !== 32) throw new Error("the sealed key is not a vault key");
  if (await readJson(`${vaultDir()}/key-check.json`)) {
    if (!(await keyMatches(await importKey(raw)))) throw new Error("the key the console sent does not open this vault");
    await pairVault(recoveryCode(raw), "file");
    return "checked";
  }
  const f = vaultKeyFile();
  await Deno.mkdir(f.slice(0, f.lastIndexOf("/")), { recursive: true, mode: 0o700 });
  await writeAtomic(f, btoa(String.fromCharCode(...raw)) + "\n", { mode: 0o600 });
  return "kept";
}
