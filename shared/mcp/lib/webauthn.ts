// webauthn.ts — the phone's yes (ADR 0014, G5): a passkey (WebAuthn, ES256 only, no attestation) that counts
// only once the owner's desktop endorsed it, and the checks a node makes before it believes an answer or a job
// that came with a passkey's assertion. Pure but for WebCrypto, and importing only nodes.ts (the canonical
// JSON and the signed text of a job), so the service's image carries it with that file, and the web app can
// build the same challenges the nodes recompute.
//
// What is checked, and where: the service only stores (it parses a registration to keep the public key, and
// never decides anything); the node verifies the endorsement with the owner's approval key, then the assertion
// (type, challenge, origin, rpIdHash, user-present and user-verified, ES256), then expiry and replay.

import { canonical, type PasskeyAssertion, signedText } from "./nodes.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
/** base64url (padded or not) to bytes; null for what is not base64url. */
export function unb64u(s: string): Uint8Array<ArrayBuffer> | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  const t = s.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
  if (t.length % 4 === 1) return null;
  try {
    return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
const sha256 = async (b: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- where and what

/** What a passkey is bound to: the service's origin and its relying party id (the host, no port). */
export interface Site {
  origin: string;
  rpId: string;
}

/** Pure: the site of the service's URL. */
export function siteOf(url: string): Site {
  const u = new URL(url);
  return { origin: u.origin, rpId: u.hostname };
}

/** A passkey as the service lists it. `publicKey` is the uncompressed P-256 point (65 bytes, base64url). */
export interface Passkey {
  id: string;
  name: string;
  publicKey: string;
  /** the owner's Ed25519 signature of `endorsementText`, absent while it waits */
  endorsement: string | null;
  created: string;
}

export const MAX_AHEAD_MS = 10 * 60_000;
const SLACK_MS = 60_000;
export type Verdict = "allow" | "session" | "deny";

/** The answer the phone signs, and what the node recomputes the challenge from. `what` is the hash of the
 *  request's words (`wordsHash`): the phone computes it from what it showed, the node from its own hub's copy. */
export interface AnswerBody {
  id: string;
  node: string;
  verdict: Verdict;
  answers?: Record<string, string>;
  expires: string;
  what: string;
}
/** An answer as the service hands it to a node: it carries no `what`, the node has its own. */
export interface PhoneAnswer extends Omit<AnswerBody, "what"> {
  assertion: PasskeyAssertion;
}

// ---------------------------------------------------------------- the words a yes is for

/** A question of an AskUserQuestion, bounded as the service keeps it. */
export interface Words {
  what: string;
  questions?: {
    question: string;
    header?: string;
    options: { label: string; description?: string }[];
    multiSelect?: true;
  }[];
}

const clip = (v: unknown, n: number) => typeof v === "string" ? v.slice(0, n) : "";

/** Pure: a request's words — what it wants to do and its questions — bounded in size and cut to the known fields.
 *  The node relays this form and hashes it, the service keeps it as it came, the phone hashes what it shows:
 *  bounding again changes nothing (it is idempotent), so all three hold the same bytes. */
export function boundWords(what: unknown, questions?: unknown): Words {
  const qs = Array.isArray(questions)
    ? questions.slice(0, 4).map((q) => {
      const x = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
      return {
        question: clip(x.question, 500),
        ...(typeof x.header === "string" ? { header: x.header.slice(0, 60) } : {}),
        options: Array.isArray(x.options)
          ? x.options.slice(0, 8).map((o) => {
            const y = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
            return {
              label: clip(y.label, 200),
              ...(typeof y.description === "string" ? { description: y.description.slice(0, 500) } : {}),
            };
          })
          : [],
        ...(x.multiSelect === true ? { multiSelect: true as const } : {}),
      };
    })
    : undefined;
  return { what: clip(what, 1000), ...(qs ? { questions: qs } : {}) };
}

/** The `what` of an answer: the base64url SHA-256 of the canonical JSON of `{what, questions}`. */
export async function wordsHash(w: { what: string; questions?: unknown }): Promise<string> {
  return b64u(await sha256(enc.encode(canonical({ what: w.what, questions: w.questions }))));
}

// ---------------------------------------------------------------- the challenges and the endorsement

/** Pure: the text the challenge of an answer is the SHA-256 of (v2: it binds the request's words). */
export const answerText = (a: AnswerBody): string =>
  `agents-multi answer v2\n${
    canonical({ id: a.id, node: a.node, verdict: a.verdict, answers: a.answers, expires: a.expires, what: a.what })
  }`;

/** The text of the first format, which no node accepts any more: kept to name it when one arrives. */
const answerTextV1 = (a: Omit<AnswerBody, "what">): string =>
  `agents-multi answer v1\n${
    canonical({ id: a.id, node: a.node, verdict: a.verdict, answers: a.answers, expires: a.expires })
  }`;

/** The WebAuthn challenge of an answer (32 bytes). */
export async function answerChallenge(a: AnswerBody): Promise<Uint8Array> {
  return await sha256(enc.encode(answerText(a)));
}

/** The WebAuthn challenge of a job's acceptance: the SHA-256 of the text the owner's key signs as well. */
export async function jobChallenge(j: Parameters<typeof signedText>[0]): Promise<Uint8Array> {
  return await sha256(enc.encode(signedText(j)));
}

/** Pure: the text a decline of a proposed job from the phone signs. */
export const jobDeclineText = (j: Parameters<typeof signedText>[0]): string =>
  `agents-multi job decline v1\n${
    canonical({ id: j.id, node: j.node, kind: j.kind, spec: j.spec, expires: j.expires })
  }`;

/** The WebAuthn challenge of declining a job. */
export async function jobDeclineChallenge(j: Parameters<typeof signedText>[0]): Promise<Uint8Array> {
  return await sha256(enc.encode(jobDeclineText(j)));
}

/** Pure: what the owner's approval key signs to endorse a passkey. */
export const endorsementText = (id: string, publicKey: string): string =>
  `agents-multi passkey v1\n${id}\n${publicKey}`;

export async function signEndorsement(id: string, publicKey: string, key: CryptoKey): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", key, enc.encode(endorsementText(id, publicKey)))));
}

/** Whether the owner's key (the public half, base64url) signed this passkey's endorsement. */
export async function verifyEndorsement(
  p: Pick<Passkey, "id" | "publicKey" | "endorsement">,
  ownerKey: string,
): Promise<boolean> {
  const sig = p.endorsement ? unb64u(p.endorsement) : null;
  if (!sig) return false;
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: ownerKey }, "Ed25519", false, [
      "verify",
    ]);
    return await crypto.subtle.verify("Ed25519", pub, sig, enc.encode(endorsementText(p.id, p.publicKey)));
  } catch {
    return false;
  }
}

/** What a person compares between the phone and the desktop: the first 8 bytes of the key's SHA-256, as
 *  `ab12-cd34-ef56-7890`. */
export async function fingerprint(publicKey: string): Promise<string> {
  const k = unb64u(publicKey);
  if (!k) return "";
  const h = [...(await sha256(k)).slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
  return h.match(/.{4}/g)!.join("-");
}

// ---------------------------------------------------------------- CBOR (the little of it WebAuthn needs)

type Cbor = number | bigint | string | boolean | null | Uint8Array | Cbor[] | Map<number | string, Cbor>;

/** Decodes one CBOR item at `at`: definite lengths only, which is all an authenticator writes. Returns the value
 *  and where the next item starts; throws on anything else. */
export function cborAt(b: Uint8Array, at = 0, depth = 0): [Cbor, number] {
  if (depth > 8) throw new Error("cbor: too deep");
  if (at >= b.length) throw new Error("cbor: truncated");
  const head = b[at++], major = head >> 5, info = head & 31;
  let n: number;
  if (info < 24) n = info;
  else if (info >= 24 && info <= 27) {
    const w = 1 << (info - 24);
    if (at + w > b.length) throw new Error("cbor: truncated");
    let v = 0n;
    for (let i = 0; i < w; i++) v = (v << 8n) | BigInt(b[at + i]);
    at += w;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cbor: number too large");
    n = Number(v);
  } else throw new Error("cbor: indefinite lengths are not supported");
  switch (major) {
    case 0:
      return [n, at];
    case 1:
      return [-1 - n, at];
    case 2:
    case 3: {
      if (at + n > b.length) throw new Error("cbor: truncated");
      const s = b.slice(at, at + n);
      return [major === 2 ? s : dec.decode(s), at + n];
    }
    case 4: {
      const out: Cbor[] = [];
      for (let i = 0; i < n; i++) {
        const [v, next] = cborAt(b, at, depth + 1);
        out.push(v);
        at = next;
      }
      return [out, at];
    }
    case 5: {
      const m = new Map<number | string, Cbor>();
      for (let i = 0; i < n; i++) {
        const [k, k2] = cborAt(b, at, depth + 1);
        if (typeof k !== "number" && typeof k !== "string") throw new Error("cbor: a map key is a number or text");
        const [v, v2] = cborAt(b, k2, depth + 1);
        m.set(k, v);
        at = v2;
      }
      return [m, at];
    }
    case 7:
      if (info === 20) return [false, at];
      if (info === 21) return [true, at];
      if (info === 22 || info === 23) return [null, at];
      throw new Error("cbor: unsupported simple value");
    default:
      throw new Error("cbor: unsupported type");
  }
}

// ---------------------------------------------------------------- registration (the service parses, never decides)

const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

/** Pure: the challenge a clientDataJSON carries, or null when it is not JSON with one. */
export function clientChallenge(clientDataJSON: string): string | null {
  const raw = unb64u(clientDataJSON);
  if (!raw) return null;
  try {
    const c = JSON.parse(dec.decode(raw));
    return typeof c?.challenge === "string" ? c.challenge : null;
  } catch {
    return null;
  }
}

function clientData(clientDataJSON: string): Record<string, unknown> | null {
  const raw = unb64u(clientDataJSON);
  if (!raw) return null;
  try {
    const c = JSON.parse(dec.decode(raw));
    return c && typeof c === "object" && !Array.isArray(c) ? c : null;
  } catch {
    return null;
  }
}

// P-256: y² = x³ - 3x + b (mod p). Not every runtime checks the point when it imports the key.
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const big = (b: Uint8Array) => b.reduce((n, x) => (n << 8n) | BigInt(x), 0n);
function onCurve(xb: Uint8Array, yb: Uint8Array): boolean {
  const x = big(xb), y = big(yb);
  if (x >= P256_P || y >= P256_P) return false;
  return ((y * y) % P256_P) === (((x * x % P256_P) * x - 3n * x + P256_B) % P256_P + P256_P) % P256_P;
}

/** A registration as the browser's `PublicKeyCredential.toJSON()` gives it. */
export interface Registration {
  id?: string;
  response: { attestationObject: string; clientDataJSON: string };
}

/** The passkey a registration makes: the credential's id and its public key, or why it is not acceptable.
 *  Attestation `none` and ES256 (alg -7, P-256) only; type `webauthn.create`, the challenge the service made,
 *  the service's origin and rpIdHash, user present and verified. */
export async function parseRegistration(
  reg: Registration,
  challenge: string,
  site: Site,
): Promise<{ id: string; publicKey: string } | { error: string }> {
  const cd = clientData(reg?.response?.clientDataJSON);
  if (!cd) return { error: "the client data is not JSON" };
  if (cd.type !== "webauthn.create") return { error: "not a registration (type)" };
  if (cd.challenge !== challenge) return { error: "the challenge is not the one asked for" };
  if (cd.origin !== site.origin) return { error: "the origin is not this service's" };
  const att = unb64u(reg.response.attestationObject);
  if (!att) return { error: "the attestation is not base64url" };
  let auth: Uint8Array;
  try {
    const [o] = cborAt(att);
    if (!(o instanceof Map)) throw new Error("not a map");
    if (o.get("fmt") !== "none") {
      return { error: `attestation ${JSON.stringify(o.get("fmt"))} is not accepted: none only` };
    }
    const a = o.get("authData");
    if (!(a instanceof Uint8Array)) throw new Error("no authData");
    auth = a;
  } catch (e) {
    return { error: `the attestation object: ${(e as Error).message}` };
  }
  if (auth.length < 55) return { error: "authenticator data too short" };
  if (!same(auth.slice(0, 32), await sha256(enc.encode(site.rpId)))) {
    return { error: "the rpIdHash is not this service's" };
  }
  const flags = auth[32];
  if (!(flags & FLAG_UP)) return { error: "user presence is not set" };
  if (!(flags & FLAG_UV)) return { error: "user verification is not set" };
  if (!(flags & FLAG_AT)) return { error: "no credential in the authenticator data" };
  const idLen = (auth[53] << 8) | auth[54];
  if (idLen < 16 || idLen > 1023 || 55 + idLen > auth.length) return { error: "the credential id has a wrong length" };
  const credId = auth.slice(55, 55 + idLen);
  const id = b64u(credId);
  if (reg.id !== undefined && reg.id !== id) return { error: "the credential id differs from the one in the data" };
  let key: Cbor;
  try {
    [key] = cborAt(auth, 55 + idLen);
  } catch (e) {
    return { error: `the public key: ${(e as Error).message}` };
  }
  if (!(key instanceof Map)) return { error: "the public key is not a COSE key" };
  const x = key.get(-2), y = key.get(-3);
  if (key.get(1) !== 2 || key.get(3) !== -7 || key.get(-1) !== 1) return { error: "the key is not ES256 (EC2, P-256)" };
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
    return { error: "the key's coordinates are not 32 bytes" };
  }
  const point = new Uint8Array(65);
  point[0] = 4;
  point.set(x, 1);
  point.set(y, 33);
  try {
    await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    if (!onCurve(x, y)) throw new Error("off the curve");
  } catch {
    return { error: "the key is not a point of P-256" };
  }
  return { id, publicKey: b64u(point) };
}

// ---------------------------------------------------------------- assertion

/** Pure: ES256 signatures come from an authenticator as ASN.1 DER; WebCrypto wants r || s, 64 bytes. Takes DER,
 *  or a raw 64-byte signature as it is; null for anything else. */
export function rawSignature(sig: Uint8Array): Uint8Array | null {
  const der = (): Uint8Array | null => {
    if (sig.length < 8 || sig[0] !== 0x30) return null;
    let i = 1, total = sig[i++];
    if (total === 0x81) total = sig[i++];
    else if (total & 0x80) return null;
    if (i + total !== sig.length) return null;
    const out = new Uint8Array(64);
    for (const at of [0, 32]) {
      if (sig[i++] !== 0x02) return null;
      const len = sig[i++];
      if (!len || i + len > sig.length) return null;
      let part = sig.subarray(i, i + len);
      i += len;
      while (part.length > 1 && part[0] === 0) part = part.subarray(1);
      if (part.length > 32) return null;
      out.set(part, at + 32 - part.length);
    }
    return i === sig.length ? out : null;
  };
  return der() ?? (sig.length === 64 ? sig : null);
}

/** Why an assertion does not hold, or null when it does: for the key `publicKey` and the challenge, on this site. */
export async function verifyAssertion(
  a: Pick<PasskeyAssertion, "authenticatorData" | "clientDataJSON" | "signature">,
  publicKey: string,
  challenge: Uint8Array,
  site: Site,
): Promise<string | null> {
  const cd = clientData(a.clientDataJSON);
  if (!cd) return "the client data is not JSON";
  if (cd.type !== "webauthn.get") return "the client data is not an assertion (type)";
  if (cd.challenge !== b64u(challenge)) return "the challenge is not the one of this answer";
  if (cd.origin !== site.origin) return "the origin is not the service's";
  if (cd.crossOrigin === true) return "made from another origin's frame";
  const auth = unb64u(a.authenticatorData);
  if (!auth || auth.length < 37) return "authenticator data too short";
  if (!same(auth.slice(0, 32), await sha256(enc.encode(site.rpId)))) return "the rpIdHash is not the service's";
  if (!(auth[32] & FLAG_UP)) return "user presence is not set";
  if (!(auth[32] & FLAG_UV)) return "user verification is not set";
  const point = unb64u(publicKey), sig = unb64u(a.signature), raw = sig && rawSignature(sig);
  if (!point || !raw) return "the signature is not ES256";
  const clientHash = await sha256(unb64u(a.clientDataJSON)!);
  const signed = new Uint8Array(auth.length + 32);
  signed.set(auth);
  signed.set(clientHash, auth.length);
  try {
    const key = await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, raw as BufferSource, signed))
      ? null
      : "the signature is not the passkey's";
  } catch {
    return "the signature is not the passkey's";
  }
}

/** Pure: an assertion as the service keeps it, or null when it lacks a part or one is out of size. */
export function cleanAssertion(raw: unknown): PasskeyAssertion | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const part = (k: string, max: number) => {
    const v = r[k];
    return typeof v === "string" && v.length > 0 && v.length <= max && unb64u(v) ? v : null;
  };
  const credential = part("credential", 1400), authenticatorData = part("authenticatorData", 1400);
  const clientDataJSON = part("clientDataJSON", 4000), signature = part("signature", 400);
  return credential && authenticatorData && clientDataJSON && signature
    ? { credential, authenticatorData, clientDataJSON, signature }
    : null;
}

// ---------------------------------------------------------------- what a node believes

/** What a node knows when it checks a phone's yes. */
export interface PasskeyCtx {
  site: Site;
  /** every passkey the service lists */
  passkeys: Passkey[];
  /** the owner's public approval key; null when this node has none */
  ownerKey: string | null;
  now: number;
  /** the credential ids revoked on a desktop (the vault's `passkey-revocations`): refused whatever the service lists */
  revoked?: ReadonlySet<string>;
}

/** Why a passkey's assertion over `challenge` does not count, or null when it does: the passkey is known, the
 *  owner's key endorsed it, and the assertion holds. */
export async function verifyPasskey(
  assertion: PasskeyAssertion,
  challenge: Uint8Array,
  ctx: PasskeyCtx,
): Promise<string | null> {
  if (ctx.revoked?.has(assertion.credential)) return "the passkey was revoked on a desktop";
  if (!ctx.ownerKey) return "this node has no approval key to check the passkey's endorsement";
  const p = ctx.passkeys.find((x) => x.id === assertion.credential);
  if (!p) return "not a passkey of this account";
  if (!p.endorsement) return "the passkey has not been endorsed on a desktop";
  if (!(await verifyEndorsement(p, ctx.ownerKey))) return "the passkey's endorsement is not the owner's";
  return await verifyAssertion(assertion, p.publicKey, challenge, ctx.site);
}

/** The key a node remembers an answer by, to refuse it a second time: the challenge it carries. */
export async function answerKey(a: AnswerBody): Promise<string> {
  return b64u(await answerChallenge(a));
}

/** Why a node must not apply a phone's answer, or null when the owner's yes holds: it is for this node, a
 *  verdict, not too far ahead nor expired, from an endorsed, unrevoked passkey whose assertion holds over the
 *  request's words as THIS node has them (`what`, from its own hub, never from the service), not used before. */
export async function verifyAnswer(
  a: PhoneAnswer,
  what: string,
  self: string,
  ctx: PasskeyCtx,
  seen: Iterable<string>,
): Promise<string | null> {
  if (a.node !== self) return `it is for ${a.node || "no node"}, not ${self}`;
  if (!["allow", "session", "deny"].includes(a.verdict)) return "the verdict is allow, session or deny";
  if (a.answers !== undefined) {
    const o = a.answers as unknown;
    if (!o || typeof o !== "object" || Array.isArray(o) || Object.values(o).some((v) => typeof v !== "string")) {
      return "the answers are text by question";
    }
  }
  const until = Date.parse(a.expires);
  if (!(until > 0)) return "no expiry";
  if (!(ctx.now < until)) return "its approval expired";
  if (until > ctx.now + MAX_AHEAD_MS + SLACK_MS) return "it holds longer than ten minutes";
  const asm = cleanAssertion(a.assertion);
  if (!asm) return "the assertion lacks a part";
  const full: AnswerBody = { id: a.id, node: a.node, verdict: a.verdict, answers: a.answers, expires: a.expires, what };
  if (clientChallenge(asm.clientDataJSON) === b64u(await sha256(enc.encode(answerTextV1(a))))) {
    return "signed in the old format (v1), which is refused: update the app and answer again";
  }
  const why = await verifyPasskey(asm, await answerChallenge(full), ctx);
  if (why) return why;
  if ([...seen].includes(await answerKey(full))) return "already used";
  return null;
}

/** Why the phone's decline of a proposed job does not count, or null when it does: the same checks as an
 *  approval, over the decline's own text, with `expires` stored by the service beside the assertion. The decline
 *  is read after the fact, so only the time it was made (`at`, the job's last update) frames `expires`. */
export async function verifyJobDecline(
  j: Parameters<typeof signedText>[0] & { assertion?: PasskeyAssertion; updated: string },
  ctx: PasskeyCtx,
  maxAheadMs = 24 * 3600_000,
): Promise<string | null> {
  const asm = cleanAssertion(j.assertion);
  if (!asm) return "the decline carries no assertion";
  const until = Date.parse(j.expires ?? ""), at = Date.parse(j.updated);
  if (!(until > 0) || !(at > 0)) return "no expiry";
  if (until < at - SLACK_MS) return "the decline had expired when it was made";
  if (until > at + maxAheadMs + SLACK_MS) return "it holds longer than a day";
  return await verifyPasskey(asm, await jobDeclineChallenge(j), ctx);
}

/** Why a job's passkey approval does not count, or null when it does (verifyJob's `viaPasskey`). */
export async function verifyJobAssertion(
  j: Parameters<typeof signedText>[0] & { assertion?: PasskeyAssertion },
  ctx: PasskeyCtx,
): Promise<string | null> {
  const asm = cleanAssertion(j.assertion);
  if (!asm) return "the assertion lacks a part";
  return await verifyPasskey(asm, await jobChallenge(j), ctx);
}
