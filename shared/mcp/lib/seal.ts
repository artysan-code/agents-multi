// seal.ts — the vault key sealed to a server node's public key (ADR 0013, «F2: pairing from the console»). The
// node, unconfigured, makes an X25519 key pair and sends the public half with its pairing request; the owner's
// console, on their machine, seals the vault key to it and hands the box over through the service, which cannot
// open it: an ephemeral X25519 key, HKDF-SHA-256 with a label of its own, AES-256-GCM, with the node's public key
// and the pairing's id as associated data (a box made for one pairing does not open for another). Pure but for
// WebCrypto; it imports only webauthn.ts's base64url and fingerprint, so the service's image may carry it too.

import { b64u, fingerprint, unb64u } from "./webauthn.ts";

const enc = new TextEncoder();
const LABEL = "agents-multi pair v1 vault-key";

/** What travels: the ephemeral public key, the nonce and the ciphertext, base64url. */
export interface Sealed {
  v: 1;
  epk: string;
  iv: string;
  ct: string;
}

/** A node's pairing key pair, as the node keeps it (`<state>/pair-key`, 0600): a JWK with its public half `x`. */
export interface PairKey {
  kty: "OKP";
  crv: "X25519";
  d: string;
  x: string;
}

/** Pure: a public key as the pairing sends it — 32 bytes, base64url — or null. */
export function cleanPublicKey(v: unknown): string | null {
  if (typeof v !== "string" || v.length > 64) return null;
  const b = unb64u(v);
  return b && b.length === 32 ? b64u(b) : null;
}

/** Pure: a sealed box as the service keeps it (known fields only, bounded), or null. */
export function cleanSealed(v: unknown): Sealed | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const part = (x: unknown, max: number) => typeof x === "string" && x.length <= max && unb64u(x) !== null;
  if (r.v !== 1 || !part(r.epk, 64) || !part(r.iv, 32) || !part(r.ct, 512)) return null;
  if (unb64u(r.epk as string)!.length !== 32 || unb64u(r.iv as string)!.length !== 12) return null;
  return { v: 1, epk: r.epk as string, iv: r.iv as string, ct: r.ct as string };
}

/** The fingerprint the node prints and the console shows, to be compared by the owner: `ab12-cd34-ef56-7890`. */
export const keyFingerprint = (publicKey: string): Promise<string> => fingerprint(publicKey);

/** A new pairing key pair. */
export async function newPairKey(): Promise<PairKey> {
  const k = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const j = await crypto.subtle.exportKey("jwk", k.privateKey);
  return { kty: "OKP", crv: "X25519", d: j.d!, x: j.x! };
}

const aad = (publicKey: string, pairing: string) => enc.encode(`${publicKey}.${pairing}`);

async function aesKey(shared: ArrayBuffer, epk: string, publicKey: string, usage: KeyUsage): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(`${epk}.${publicKey}`), info: enc.encode(LABEL) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

/** The vault key (`raw`, 32 bytes) sealed to the node's public key for this pairing. */
export async function sealTo(raw: Uint8Array, publicKey: string, pairing: string): Promise<Sealed> {
  const pub = cleanPublicKey(publicKey);
  if (!pub) throw new Error("not a node's public key");
  const peer = await crypto.subtle.importKey("raw", unb64u(pub)!, { name: "X25519" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]) as CryptoKeyPair;
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: peer }, eph.privateKey, 256);
  const epk = b64u(new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey)));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(pub, pairing) },
    await aesKey(shared, epk, pub, "encrypt"),
    raw as BufferSource,
  );
  return { v: 1, epk, iv: b64u(iv), ct: b64u(new Uint8Array(ct)) };
}

/** The node opens the box with its private key: the vault key's bytes. Throws when the box was made for another
 *  key or another pairing, or was changed on the way. */
export async function openSealed(box: Sealed, key: PairKey, pairing: string): Promise<Uint8Array> {
  const s = cleanSealed(box);
  if (!s) throw new Error("not a sealed vault key");
  const priv = await crypto.subtle.importKey("jwk", { ...key, key_ops: ["deriveBits"] }, { name: "X25519" }, false, [
    "deriveBits",
  ]);
  const eph = await crypto.subtle.importKey("raw", unb64u(s.epk)!, { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: eph }, priv, 256);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64u(s.iv)!, additionalData: aad(key.x, pairing) },
    await aesKey(shared, s.epk, key.x, "decrypt"),
    unb64u(s.ct)!,
  );
  return new Uint8Array(plain);
}
