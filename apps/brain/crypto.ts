// crypto.ts — the brain's small primitives: random tokens, SHA-256 in base64url, a comparison in
// constant time, and TOTP (RFC 6238) with its base32. No state, no imports: auth.ts (sessions, OAuth,
// tokens) and users.ts (accounts) both use them, and neither has to import the other for them.

const enc = new TextEncoder();
const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}
/** Pure-ish: equal strings in time that does not depend on where they differ. */
export function same(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

// ---------------------------------------------------------------- TOTP (RFC 6238: SHA-1, 30 s, 6 digits)
export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = A.indexOf(c);
    if (i < 0) throw new Error("not base32");
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
export function base32Encode(b: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0, out = "";
  for (const x of b) {
    val = (val << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += A[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += A[(val << (5 - bits)) & 31];
  return out;
}
export async function totp(secret: string, at = Date.now(), step = 30): Promise<string> {
  const counter = Math.floor(at / 1000 / step);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000;
  return String(n).padStart(6, "0");
}
/** The code of this window or of the one either side: a phone's clock is seldom exact. */
export async function totpOk(secret: string, code: string, at = Date.now()): Promise<boolean> {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  for (const d of [0, -30_000, 30_000]) if (same(await totp(secret, at + d), c)) return true;
  return false;
}
