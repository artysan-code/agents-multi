// backup.ts — the brain as one encrypted file, for the owner's machines to fetch and keep.
//
// A consistent copy of the database (see sealedCopy), sealed with
// AES-256-GCM under BRAIN_BACKUP_KEY (32 bytes, base64): the server never hands out the brain in
// clear, and the machines keeping copies cannot read them without the key from the vault.
// Format: "BRN1", a 12-byte IV, the ciphertext.

import { backup, DatabaseSync } from "node:sqlite";

const MAGIC = new TextEncoder().encode("BRN1");

async function keyOf(b64: string, use: KeyUsage) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("BRAIN_BACKUP_KEY must be 32 bytes, base64");
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);
}

export async function seal(plain: Uint8Array<ArrayBuffer>, b64key: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(b64key, "encrypt"), plain),
  );
  const out = new Uint8Array(4 + 12 + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, 4);
  out.set(ct, 16);
  return out;
}

export async function open(sealed: Uint8Array<ArrayBuffer>, b64key: string): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < 17 || new TextDecoder().decode(sealed.subarray(0, 4)) !== "BRN1") {
    throw new Error("not a brain backup");
  }
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: sealed.slice(4, 16) },
      await keyOf(b64key, "decrypt"),
      sealed.slice(16),
    ),
  );
}

/** A database file as one sealed copy, taken from a connection of its own, so it works from another
 *  process than the one serving (the admin CLI) as well as from the server's scheduled job: SQLite's
 *  online backup copies a consistent state while writers go on. The plain copy exists only as a
 *  temporary file in `tmpDir` (mode 0600), removed before this returns. */
export async function sealedCopy(file: string, b64key: string, tmpDir: string): Promise<Uint8Array<ArrayBuffer>> {
  const tmp = await Deno.makeTempFile({ dir: tmpDir, suffix: ".tmp" });
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    src.exec("pragma busy_timeout = 5000");
    await backup(src, tmp);
    return await seal(Deno.readFileSync(tmp) as Uint8Array<ArrayBuffer>, b64key);
  } finally {
    src.close();
    await Deno.remove(tmp).catch(() => {});
  }
}

/** The sealed copy of one account's brain for /backup: SQLite's online backup, in steps, so the
 *  request does not hold the event loop (a checkpoint and a whole-file read in one tick did). The
 *  temporary plain copy lives beside the database, in the account's own folder. */
export function snapshot(dbFile: string, b64key: string): Promise<Uint8Array<ArrayBuffer>> {
  return sealedCopy(dbFile, b64key, dbFile.slice(0, dbFile.lastIndexOf("/")));
}
