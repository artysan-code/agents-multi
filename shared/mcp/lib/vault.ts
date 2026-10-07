// vault.ts — claude-multi's secret store: every credential an MCP server needs, encrypted, the same
// on every machine.
//
// Where things are:
//   the entries   ~/vault/claude-multi/secrets/<id>.json (CLAUDE_MULTI_VAULT overrides the directory).
//                 ~/vault is a Syncthing folder: the entries travel between machines already
//                 encrypted, and a relay device in between cannot read them.
//   the key       one per vault, 256 bits, in each machine's keyring through the Secret Service API
//                 (KWallet / ksecretd here, unlocked at login): no password to type, and never on disk
//                 next to the entries.
//
// Each entry is its own file, so two machines only collide when they change the same secret at the
// same moment. A deletion is a tombstone (the entry rewritten as deleted), never a removed file:
// with a relay holding encrypted data, a removal can lose against a concurrent "modification" of the
// same file and come back, while a write always goes through. Never restore this directory from a backup onto a reinstalled
// machine: pair it with the recovery code and let Syncthing bring the entries, with clean history. Its name is an HMAC of service/account/field under the vault key: a lookup needs no
// scan, and the file names say nothing about what is inside. The content is AES-GCM (WebCrypto,
// built into Deno) with a fresh IV per write and the entry id as associated data, so an entry cannot
// be swapped for another one unnoticed.
//
// A new machine gets the key once, from the recovery code (`agents vault recovery-code` on a
// machine that has it, `agents vault pair` on the new one). key-check.json tells a right key
// from a wrong one before anything is written with it.
//
// Nothing here prints a secret. The only way a value leaves this module is the return value of
// getSecret(), and the MCP servers use it for their HTTP headers, never in a tool result.

import { amEnv } from "./env.ts";

const HOME = Deno.env.get("HOME") ?? "";
const SECRET_TOOL = "/usr/bin/secret-tool";
const KEY_ATTRS = ["application", "claude-multi", "kind", "vault-key"];
// The plaintext sealed in every vault's key-check.json. It is data, not a name: it is the text a key must
// open, so it keeps the project's name from before Agents Multi, as do the HKDF infos below. Never rename.
export const CHECK_TEXT = "claude-multi vault";
const enc = new TextEncoder();
const dec = new TextDecoder();

export function vaultDir(): string {
  return amEnv("VAULT") ?? `${HOME}/vault/claude-multi`;
}

export interface Entry {
  service: string;
  account: string;
  field: string;
  value: string;
  updatedAt: string;
  deleted?: boolean;
}
export type EntryMeta = Omit<Entry, "value" | "deleted">;

// ---------------------------------------------------------------- key material
export interface VaultKey {
  aes: CryptoKey;
  hmac: CryptoKey;
  raw: Uint8Array;
}

export async function importKey(raw: Uint8Array): Promise<VaultKey> {
  if (raw.length !== 32) throw new Error("a vault key is 32 bytes");
  // two keys derived from one secret: the same bytes are never used for two algorithms
  const base = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveKey"]);
  const derive = (info: string, alg: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
    crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) },
      base,
      alg,
      false,
      usages,
    );
  return {
    aes: await derive("claude-multi/entries", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
    hmac: await derive("claude-multi/names", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
    raw,
  };
}

export function newKeyBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Crockford base32: no I, L, O, U, so a code read aloud or retyped survives.
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The key as a recovery code: 52 characters in groups of four. */
export function recoveryCode(raw: Uint8Array): string {
  let bits = 0, acc = 0, out = "";
  for (const byte of raw) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

/** The code back to key bytes: case, spaces, dashes and the usual look-alikes forgiven. */
export function parseRecoveryCode(code: string): Uint8Array {
  const clean = code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  let bits = 0, acc = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`not a recovery code character: ${ch}`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (out.length !== 32) throw new Error("a recovery code holds exactly 32 bytes: check it was copied whole");
  return new Uint8Array(out);
}

// ---------------------------------------------------------------- entries (pure given a key)
export async function entryId(key: VaultKey, service: string, account: string, field: string): Promise<string> {
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key.hmac, enc.encode(`${service}\n${account}\n${field}`)),
  );
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function seal(key: VaultKey, id: string, plain: string): Promise<{ v: 1; iv: string; ct: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(id) }, key.aes, enc.encode(plain)),
  );
  return { v: 1, iv: b64(iv), ct: b64(ct) };
}

export async function open(key: VaultKey, id: string, box: { iv: string; ct: string }): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(box.iv) as BufferSource, additionalData: enc.encode(id) },
    key.aes,
    unb64(box.ct) as BufferSource,
  );
  return dec.decode(pt);
}

// ---------------------------------------------------------------- the keyring
async function secretTool(args: string[], stdin?: string): Promise<{ code: number; out: string }> {
  const p = new Deno.Command(SECRET_TOOL, {
    args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  if (stdin !== undefined) {
    const w = p.stdin.getWriter();
    await w.write(enc.encode(stdin));
    await w.close();
  }
  const r = await p.output();
  return { code: r.code, out: dec.decode(r.stdout).trim() };
}

export class VaultError extends Error {}

/** This machine's vault key, from the keyring. */
export async function loadKey(): Promise<VaultKey> {
  let r: { code: number; out: string };
  try {
    r = await secretTool(["lookup", ...KEY_ATTRS]);
  } catch {
    throw new VaultError("the keyring cannot be reached (secret-tool missing, or no desktop session)");
  }
  if (r.code !== 0 || !r.out) {
    throw new VaultError(
      "this machine has no vault key: `agents vault pair` (or `vault init` on the first machine)",
    );
  }
  return await importKey(unb64(r.out));
}

async function storeKey(raw: Uint8Array) {
  const r = await secretTool(["store", "--label=agents vault key", ...KEY_ATTRS], b64(raw));
  if (r.code !== 0) throw new VaultError("the keyring refused the vault key");
}

// ---------------------------------------------------------------- the store
const entriesDir = () => `${vaultDir()}/secrets`;
const checkFile = () => `${vaultDir()}/key-check.json`;

async function readJsonFile<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(p)) as T;
  } catch {
    return null;
  }
}

/** Write via a temporary file and a rename: Syncthing never ships half an entry. */
async function writeAtomic(p: string, text: string) {
  const tmp = `${p}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, text, { mode: 0o600 });
  await Deno.rename(tmp, p);
}

/** Does this key open this vault? True for a vault that has no check yet (a new one). */
export async function keyMatches(key: VaultKey): Promise<boolean> {
  const box = await readJsonFile<{ iv: string; ct: string }>(checkFile());
  if (!box) return true;
  try {
    return (await open(key, "key-check", box)) === CHECK_TEXT;
  } catch {
    return false;
  }
}

/** First machine: a new key, in the keyring, and the check next to the entries. */
export async function initVault(): Promise<string> {
  if (await readJsonFile(checkFile())) {
    throw new VaultError(`a vault already exists in ${vaultDir()}: pair this machine with its recovery code instead`);
  }
  const raw = newKeyBytes();
  const key = await importKey(raw);
  await Deno.mkdir(entriesDir(), { recursive: true, mode: 0o700 });
  await writeAtomic(checkFile(), JSON.stringify(await seal(key, "key-check", CHECK_TEXT)) + "\n");
  await storeKey(raw);
  return recoveryCode(raw);
}

/** Any other machine: the key from a recovery code, checked against the vault before it is kept. */
export async function pairVault(code: string) {
  const raw = parseRecoveryCode(code);
  const key = await importKey(raw);
  if (!(await readJsonFile(checkFile()))) {
    throw new VaultError(
      `no vault in ${vaultDir()} yet: wait for Syncthing, or run \`vault init\` if this is the first machine`,
    );
  }
  if (!(await keyMatches(key))) throw new VaultError("this recovery code does not open the vault");
  await storeKey(raw);
}

export async function getSecret(
  service: string,
  account: string,
  field = "token",
  key?: VaultKey,
): Promise<string | null> {
  const k = key ?? await loadKey();
  const id = await entryId(k, service, account, field);
  const box = await readJsonFile<{ iv: string; ct: string }>(`${entriesDir()}/${id}.json`);
  if (!box) return null;
  const e = JSON.parse(await open(k, id, box)) as Entry;
  return e.deleted ? null : e.value;
}

export async function setSecret(service: string, account: string, value: string, field = "token", key?: VaultKey) {
  if (!value) throw new VaultError("an empty secret is not stored");
  const k = key ?? await loadKey();
  if (!(await keyMatches(k))) throw new VaultError("this machine's key does not open the vault");
  const id = await entryId(k, service, account, field);
  const entry: Entry = { service, account, field, value, updatedAt: new Date().toISOString() };
  await Deno.mkdir(entriesDir(), { recursive: true, mode: 0o700 });
  await writeAtomic(`${entriesDir()}/${id}.json`, JSON.stringify(await seal(k, id, JSON.stringify(entry))) + "\n");
}

/** Deletes by writing a tombstone (see the top of the file): true if there was a secret to delete. */
export async function deleteSecret(
  service: string,
  account: string,
  field = "token",
  key?: VaultKey,
): Promise<boolean> {
  const k = key ?? await loadKey();
  if ((await getSecret(service, account, field, k)) === null) return false;
  const id = await entryId(k, service, account, field);
  const entry: Entry = { service, account, field, value: "", deleted: true, updatedAt: new Date().toISOString() };
  await writeAtomic(`${entriesDir()}/${id}.json`, JSON.stringify(await seal(k, id, JSON.stringify(entry))) + "\n");
  return true;
}

/** What the vault holds, without the values. Entries this key cannot open are counted, not hidden;
 *  Syncthing conflict copies are counted too, for the doctor to raise. */
export async function listSecrets(
  key?: VaultKey,
): Promise<{ entries: EntryMeta[]; unreadable: number; conflicts: number }> {
  const k = key ?? await loadKey();
  const entries: EntryMeta[] = [];
  let unreadable = 0, conflicts = 0;
  let files: Deno.DirEntry[] = [];
  try {
    files = [...Deno.readDirSync(entriesDir())];
  } catch { /* empty vault */ }
  for (const f of files) {
    if (f.name.includes(".sync-conflict-")) {
      conflicts++;
      continue;
    }
    if (!/^[0-9a-f]{32}\.json$/.test(f.name)) continue; // temporaries
    const id = f.name.slice(0, -5);
    try {
      const box = await readJsonFile<{ iv: string; ct: string }>(`${entriesDir()}/${f.name}`);
      const { value: _v, deleted, ...meta } = JSON.parse(await open(k, id, box!)) as Entry;
      if (!deleted) entries.push(meta);
    } catch {
      unreadable++;
    }
  }
  return {
    entries: entries.sort((a, b) => `${a.service}/${a.account}`.localeCompare(`${b.service}/${b.account}`)),
    unreadable,
    conflicts,
  };
}

/** For `vault recovery-code`: this machine's key, as the code another machine pairs with. */
export async function currentRecoveryCode(): Promise<string> {
  return recoveryCode((await loadKey()).raw);
}
