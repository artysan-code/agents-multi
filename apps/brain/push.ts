// push.ts — Web Push for the phone (ADR 0014, G3): the service's VAPID keys, the devices an account has
// subscribed, and the three RFCs written out over WebCrypto: 8030 (the delivery), 8291 (the payload, encrypted
// to the device's key as aes128gcm) and 8292 (the VAPID JWT, ES256). No dependency: it is about 150 lines, it has
// the RFC 8291 test vector, and a package would bring node-only crypto into a service that runs on Deno.

import type { DatabaseSync } from "node:sqlite";

const enc = new TextEncoder();

export const b64u = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = (s: string): Uint8Array<ArrayBuffer> => {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const cat = (...a: Uint8Array[]): Uint8Array => {
  const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of a) {
    o.set(x, i);
    i += x.length;
  }
  return o;
};
const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

// ---------------------------------------------------------------- RFC 8291: the payload

const hkdf = async (salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) },
      await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]),
      bytes * 8,
    ),
  );

/** An ECDH P-256 private key from its 32 bytes and the matching uncompressed public point. */
export async function ecdhPrivate(d: Uint8Array, pub: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: b64u(d), x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

export interface Sender {
  /** the application server's key pair for this message (made fresh when absent) */
  key?: { privateKey: CryptoKey; publicRaw: Uint8Array };
  /** 16 random bytes (made fresh when absent) */
  salt?: Uint8Array;
}

/** The body of a Web Push request (RFC 8291, aes128gcm, one record): the payload encrypted to the device's public
 *  key `uaPublic` (65 bytes) and `authSecret` (16 bytes). */
export async function encryptPayload(
  payload: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  s: Sender = {},
): Promise<Uint8Array> {
  let key = s.key;
  if (!key) {
    const k = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    key = {
      privateKey: k.privateKey,
      publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)),
    };
  }
  const salt = s.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ua = await crypto.subtle.importKey("raw", buf(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, key.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, cat(enc.encode("WebPush: info\0"), uaPublic, key.publicRaw), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["encrypt"]);
  // one record, the last one: the payload, then the delimiter 0x02
  const record = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, aes, buf(cat(payload, new Uint8Array([2])))),
  );
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, new Uint8Array([key.publicRaw.length]), key.publicRaw, record);
}

// ---------------------------------------------------------------- RFC 8292: VAPID

export interface Vapid {
  /** the public key as browsers take it (`applicationServerKey`): base64url of the 65-byte point */
  publicKey: string;
  signing: CryptoKey;
  /** a contact for the push services: an https: or mailto: address */
  subject: string;
}

/** The service's VAPID key: read from `<dir>/vapid.json`, or made and written there (owner-only) on first use. */
export async function loadVapid(dir: string, subject: string): Promise<Vapid> {
  const file = `${dir.replace(/\/+$/, "")}/vapid.json`;
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(await Deno.readTextFile(file));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    jwk = await crypto.subtle.exportKey("jwk", k.privateKey);
    await Deno.writeTextFile(file, JSON.stringify(jwk), { mode: 0o600, createNew: true }).catch(async (err) => {
      // two starts at once: the one that wrote first wins
      if (!(err instanceof Deno.errors.AlreadyExists)) throw err;
      jwk = JSON.parse(await Deno.readTextFile(file));
    });
  }
  return await vapidFrom(jwk, subject);
}

export async function vapidFrom(jwk: JsonWebKey, subject: string): Promise<Vapid> {
  const signing = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const publicKey = b64u(cat(new Uint8Array([4]), unb64u(jwk.x!), unb64u(jwk.y!)));
  return { publicKey, signing, subject };
}

/** The `Authorization` header of a push to `endpoint` (RFC 8292): an ES256 JWT for the push service's origin. */
export async function vapidHeader(v: Vapid, endpoint: string, nowMs = Date.now()): Promise<string> {
  const part = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
  const input = `${part({ typ: "JWT", alg: "ES256" })}.${
    part({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: v.subject })
  }`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.signing, enc.encode(input)),
  );
  return `vapid t=${input}.${b64u(sig)}, k=${v.publicKey}`;
}

// ---------------------------------------------------------------- subscriptions and sending

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device?: string;
}

/** Pure: a subscription as the service accepts it, or why not: an https endpoint on a public name, and the two
 *  keys of the right size. */
export function cleanSubscription(raw: unknown): Subscription | string {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const keys = (r.keys && typeof r.keys === "object" ? r.keys : {}) as Record<string, unknown>;
  let url: URL;
  try {
    url = new URL(String(r.endpoint));
  } catch {
    return "endpoint is a URL";
  }
  const host = url.hostname;
  if (
    url.protocol !== "https:" || String(r.endpoint).length > 700 || url.username || url.password ||
    host === "localhost" || host.endsWith(".localhost") || !host.includes(".") || /^[\d.]+$/.test(host) ||
    host.startsWith("[")
  ) return "endpoint is the https address of a push service";
  try {
    if (unb64u(String(keys.p256dh)).length !== 65 || unb64u(String(keys.auth)).length !== 16) throw 0;
  } catch {
    return "keys are p256dh (65 bytes) and auth (16 bytes), base64url";
  }
  return {
    endpoint: String(r.endpoint),
    keys: { p256dh: String(keys.p256dh), auth: String(keys.auth) },
    device: typeof r.device === "string" ? r.device.slice(0, 80) : "",
  };
}

export class Subscriptions {
  constructor(private db: DatabaseSync, private now = () => Date.now()) {}

  add(s: Subscription) {
    this.db.prepare(
      "insert into push_subs (endpoint, p256dh, auth, device, created) values (?, ?, ?, ?, ?) on conflict(endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device",
    ).run(s.endpoint, s.keys.p256dh, s.keys.auth, s.device ?? "", new Date(this.now()).toISOString());
  }

  remove(endpoint: string): boolean {
    return Number(this.db.prepare("delete from push_subs where endpoint = ?").run(endpoint).changes) > 0;
  }

  all(): Subscription[] {
    return (this.db.prepare("select endpoint, p256dh, auth, device from push_subs order by created")
      .all() as unknown as {
        endpoint: string;
        p256dh: string;
        auth: string;
        device: string;
      }[]).map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth }, device: r.device }));
  }
}

/** One push: "ok", "gone" when the push service says the subscription no longer exists (404, 410), else "error". */
export async function sendPush(
  v: Vapid,
  s: Subscription,
  payload: unknown,
  fetcher: typeof fetch = fetch,
): Promise<"ok" | "gone" | "error"> {
  try {
    const body = await encryptPayload(enc.encode(JSON.stringify(payload)), unb64u(s.keys.p256dh), unb64u(s.keys.auth));
    const r = await fetcher(s.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidHeader(v, s.endpoint),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "86400",
        urgency: "normal",
      },
      body: buf(body),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    await r.body?.cancel();
    return r.status === 404 || r.status === 410 ? "gone" : r.ok ? "ok" : "error";
  } catch {
    return "error";
  }
}

/** The payload a device shows: kept small (a push service takes about 4 KB). */
export function noticeOf(n: { chat: string; turn: string; title: string; body: string; failed: boolean }) {
  return {
    title: n.failed ? `${n.title} (failed)`.slice(0, 100) : n.title.slice(0, 100),
    body: n.body.slice(0, 200),
    chat: n.chat,
    turn: n.turn,
    failed: n.failed,
  };
}

/** A push to every device of the account; the ones the push service no longer knows are removed. */
export async function pushAll(
  v: Vapid,
  db: DatabaseSync,
  payload: unknown,
  fetcher: typeof fetch = fetch,
): Promise<{ sent: number; removed: number }> {
  const subs = new Subscriptions(db);
  let sent = 0, removed = 0;
  await Promise.all(
    subs.all().map(async (s) => {
      const r = await sendPush(v, s, payload, fetcher);
      if (r === "ok") sent++;
      else if (r === "gone" && subs.remove(s.endpoint)) removed++;
    }),
  );
  return { sent, removed };
}

/** The push routes, for any caller of the account. Null when the path is not theirs. */
export async function pushRoute(req: Request, u: URL, v: Vapid, subs: Subscriptions): Promise<Response | null> {
  const p = u.pathname;
  const json = (x: unknown, status = 200) =>
    new Response(JSON.stringify(x), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  if (p === "/api/push/key" && req.method === "GET") return json({ key: v.publicKey });
  if (p === "/api/push/subscriptions" && (req.method === "POST" || req.method === "DELETE")) {
    const b = await req.json().catch(() => null);
    if (req.method === "DELETE") {
      subs.remove(typeof b?.endpoint === "string" ? b.endpoint : "");
      return json({ ok: true });
    }
    const s = cleanSubscription(b);
    if (typeof s === "string") return json({ error: s }, 400);
    subs.add(s);
    return json({ ok: true });
  }
  return null;
}
