// authenticator.ts — a fake WebAuthn authenticator for the tests of the phone's yes (ADR 0014, G5): a real P-256
// key that makes real authenticator data, client data, attestation objects and DER signatures, as a phone does.
import { b64u, siteOf } from "../../../../shared/mcp/lib/webauthn.ts";

const enc = new TextEncoder();
export const SITE = siteOf("https://brain.example.org");
const sha = async (b: Uint8Array | string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", typeof b === "string" ? enc.encode(b) : b as BufferSource));

// ---- a minimal CBOR writer for the attestation object and the COSE key
export const head = (major: number, n: number) =>
  n < 24 ? [(major << 5) | n] : n < 256 ? [(major << 5) | 24, n] : [(major << 5) | 25, n >> 8, n & 255];
export const cint = (n: number) => n >= 0 ? head(0, n) : head(1, -1 - n);
export const cbytes = (b: Uint8Array) => [...head(2, b.length), ...b];
export const ctext = (s: string) => [...head(3, s.length), ...enc.encode(s)];

export function coseKey(point: Uint8Array, over: { alg?: number; crv?: number; kty?: number } = {}) {
  return new Uint8Array([
    ...head(5, 5),
    ...cint(1),
    ...cint(over.kty ?? 2),
    ...cint(3),
    ...cint(over.alg ?? -7),
    ...cint(-1),
    ...cint(over.crv ?? 1),
    ...cint(-2),
    ...cbytes(point.slice(1, 33)),
    ...cint(-3),
    ...cbytes(point.slice(33, 65)),
  ]);
}

/** A DER signature from r || s, as an authenticator writes it. */
export function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return [0x02, v.length, ...v];
  };
  const body = [...int(raw.slice(0, 32)), ...int(raw.slice(32))];
  return new Uint8Array([0x30, ...(body.length > 127 ? [0x81, body.length] : [body.length]), ...body]);
}

export class Authenticator {
  credId = crypto.getRandomValues(new Uint8Array(32));
  constructor(public pair: CryptoKeyPair, public point: Uint8Array) {}
  static async make() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    return new Authenticator(pair, new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  }
  get id() {
    return b64u(this.credId);
  }
  get publicKey() {
    return b64u(this.point);
  }

  async authData(o: { flags?: number; rpId?: string; attested?: boolean; key?: Uint8Array } = {}) {
    const flags = o.flags ?? (0x01 | 0x04 | (o.attested ? 0x40 : 0));
    const head = [...await sha(o.rpId ?? SITE.rpId), flags, 0, 0, 0, 1];
    if (!o.attested) return new Uint8Array(head);
    return new Uint8Array([
      ...head,
      ...new Uint8Array(16),
      this.credId.length >> 8,
      this.credId.length & 255,
      ...this.credId,
      ...(o.key ?? coseKey(this.point)),
    ]);
  }

  async register(
    challenge: string,
    o: { type?: string; origin?: string; fmt?: string; key?: Uint8Array } & Parameters<Authenticator["authData"]>[0] =
      {},
  ) {
    const clientDataJSON = enc.encode(
      JSON.stringify({ type: o.type ?? "webauthn.create", challenge, origin: o.origin ?? SITE.origin }),
    );
    const authData = await this.authData({ attested: true, ...o });
    const att = new Uint8Array([
      ...head(5, 3),
      ...ctext("fmt"),
      ...ctext(o.fmt ?? "none"),
      ...ctext("attStmt"),
      ...head(5, 0),
      ...ctext("authData"),
      ...cbytes(authData),
    ]);
    return {
      id: this.id,
      response: { attestationObject: b64u(att), clientDataJSON: b64u(clientDataJSON) },
    };
  }

  async assert(
    challenge: Uint8Array,
    o: { type?: string; origin?: string; flags?: number; rpId?: string; derSig?: boolean; crossOrigin?: boolean } = {},
  ) {
    const clientDataJSON = enc.encode(JSON.stringify({
      type: o.type ?? "webauthn.get",
      challenge: b64u(challenge),
      origin: o.origin ?? SITE.origin,
      ...(o.crossOrigin ? { crossOrigin: true } : {}),
    }));
    const authenticatorData = await this.authData({ flags: o.flags, rpId: o.rpId });
    const signed = new Uint8Array([...authenticatorData, ...await sha(clientDataJSON)]);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.pair.privateKey, signed),
    );
    return {
      credential: this.id,
      authenticatorData: b64u(authenticatorData),
      clientDataJSON: b64u(clientDataJSON),
      signature: b64u(o.derSig === false ? raw : der(raw)),
    };
  }
}
