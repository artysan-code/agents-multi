// backup.ts — the brain as one encrypted file, for Samuel's machines to fetch and keep.
//
// A consistent copy of the database (VACUUM INTO, safe while the service writes), sealed with
// AES-256-GCM under BRAIN_BACKUP_KEY (32 bytes, base64): the server never hands out the brain in
// clear, and the machines keeping copies cannot read them without the key from the vault.
// Format: "BRN1", a 12-byte IV, the ciphertext.

import type { Store } from "./store.ts";

const MAGIC = new TextEncoder().encode("BRN1");

async function keyOf(b64: string, use: KeyUsage) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("BRAIN_BACKUP_KEY must be 32 bytes, base64");
  return await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [use]);
}

export async function seal(plain: Uint8Array<ArrayBuffer>, b64key: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyOf(b64key, "encrypt"), plain));
  const out = new Uint8Array(4 + 12 + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, 4);
  out.set(ct, 16);
  return out;
}

export async function open(sealed: Uint8Array<ArrayBuffer>, b64key: string): Promise<Uint8Array<ArrayBuffer>> {
  if (sealed.length < 17 || new TextDecoder().decode(sealed.subarray(0, 4)) !== "BRN1") throw new Error("not a brain backup");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(4, 16) }, await keyOf(b64key, "decrypt"), sealed.slice(16)));
}

export async function snapshot(store: Store, dir: string, b64key: string): Promise<Uint8Array<ArrayBuffer>> {
  const tmp = `${dir}/.snapshot-${crypto.randomUUID()}.db`;
  try {
    store.db.prepare("vacuum into ?").run(tmp);
    return await seal(await Deno.readFile(tmp), b64key);
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}
