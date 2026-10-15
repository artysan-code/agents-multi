// push_test.ts — Web Push (push.ts): the payload encryption against RFC 8291 appendix A, the VAPID JWT, the
// subscriptions, and what a push service's 404/410 does.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  b64u,
  cleanSubscription,
  ecdhPrivate,
  encryptPayload,
  loadVapid,
  noticeOf,
  pushAll,
  pushRoute,
  sendPush,
  Subscriptions,
  unb64u,
  type Vapid,
  vapidHeader,
} from "../push.ts";
import { Store } from "../store.ts";

// RFC 8291, appendix A
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const BODY =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

Deno.test("push: the payload encrypts to the RFC 8291 test vector", async () => {
  const privateKey = await ecdhPrivate(unb64u(AS_PRIVATE), unb64u(AS_PUBLIC));
  const body = await encryptPayload(
    new TextEncoder().encode("When I grow up, I want to be a watermelon"),
    unb64u(UA_PUBLIC),
    unb64u(AUTH),
    { key: { privateKey, publicRaw: unb64u(AS_PUBLIC) }, salt: unb64u(SALT) },
  );
  assertEquals(b64u(body), BODY);
});

Deno.test("push: a fresh message decrypts with the device's key", async () => {
  const ua = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey("raw", ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = await encryptPayload(new TextEncoder().encode('{"title":"hi"}'), uaPub, auth);
  // the device's side (RFC 8291 section 3.4)
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), rec = body.slice(21 + idlen);
  assertEquals([idlen, new DataView(body.buffer).getUint32(16)], [65, 4096]);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "ECDH",
        public: await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []),
      },
      ua.privateKey,
      256,
    ),
  );
  const hk = async (s: Uint8Array<ArrayBuffer>, k: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
    new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: s, info },
        await crypto.subtle.importKey("raw", k, "HKDF", false, ["deriveBits"]),
        n * 8,
      ),
    );
  const e = new TextEncoder();
  const info = new Uint8Array([...e.encode("WebPush: info\0"), ...uaPub, ...asPub]);
  const ikm = await hk(auth, shared, info, 32);
  const cek = await hk(salt, ikm, e.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hk(salt, ikm, e.encode("Content-Encoding: nonce\0"), 12);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
      rec,
    ),
  );
  assertEquals(new TextDecoder().decode(plain.slice(0, -1)), '{"title":"hi"}');
  assertEquals(plain.at(-1), 2);
});

async function vapid(): Promise<{ v: Vapid; verify: CryptoKey }> {
  const dir = await Deno.makeTempDir();
  try {
    const v = await loadVapid(dir, "https://brain.example.com");
    // the keys are kept: a second start has the same one
    assertEquals((await loadVapid(dir, "https://brain.example.com")).publicKey, v.publicKey);
    assertEquals((await Deno.stat(`${dir}/vapid.json`)).mode! & 0o777, 0o600);
    const raw = unb64u(v.publicKey);
    assertEquals([raw.length, raw[0]], [65, 4]);
    const verify = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return { v, verify };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("push: the VAPID header is an ES256 JWT for the push service's origin", async () => {
  const { v, verify } = await vapid();
  const now = Date.parse("2026-10-15T20:00:00Z");
  const h = await vapidHeader(v, "https://push.example.net/send/abc", now);
  const m = h.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/)!;
  assert(m);
  assertEquals(m[4], v.publicKey);
  assertEquals(JSON.parse(new TextDecoder().decode(unb64u(m[1]))), { typ: "JWT", alg: "ES256" });
  assertEquals(JSON.parse(new TextDecoder().decode(unb64u(m[2]))), {
    aud: "https://push.example.net",
    exp: now / 1000 + 12 * 3600,
    sub: "https://brain.example.com",
  });
  assert(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verify,
      unb64u(m[3]),
      new TextEncoder().encode(`${m[1]}.${m[2]}`),
    ),
  );
});

const sub = (endpoint = "https://push.example.net/send/abc") => ({
  endpoint,
  keys: { p256dh: UA_PUBLIC, auth: AUTH },
  device: "phone",
});

Deno.test("push: a subscription is checked", () => {
  assertEquals(typeof cleanSubscription(sub()), "object");
  for (
    const e of [
      "http://push.example.net/x",
      "https://localhost/x",
      "https://10.0.0.1/x",
      "nope",
      "https://u:p@a.example.net/",
    ]
  ) {
    assertEquals(typeof cleanSubscription(sub(e)), "string", e);
  }
  assertEquals(typeof cleanSubscription({ ...sub(), keys: { p256dh: "AAAA", auth: AUTH } }), "string");
  assertEquals(typeof cleanSubscription(null), "string");
});

Deno.test("push: the routes keep and drop a device; a 404 or 410 from the push service removes it", async () => {
  const { v } = await vapid();
  const db = new Store(":memory:").db;
  const subs = new Subscriptions(db);
  const call = async (method: string, path: string, body?: unknown) => {
    const req = new Request(`https://b.test${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    const r = await pushRoute(req, new URL(req.url), v, subs);
    return { status: r!.status, body: await r!.json() };
  };
  assertEquals((await call("GET", "/api/push/key")).body, { key: v.publicKey });
  assertEquals((await call("POST", "/api/push/subscriptions", sub())).body, { ok: true });
  assertEquals((await call("POST", "/api/push/subscriptions", sub("https://old.example.net/g"))).body, { ok: true });
  assertEquals((await call("POST", "/api/push/subscriptions", { endpoint: "x" })).status, 400);
  assertEquals(subs.all().length, 2);

  const seen: { url: string; headers: Headers; len: number }[] = [];
  const fetcher = ((url: string, init: RequestInit) => {
    seen.push({ url, headers: new Headers(init.headers), len: (init.body as ArrayBuffer).byteLength });
    return Promise.resolve(new Response(null, { status: url.includes("old.") ? 410 : 201 }));
  }) as unknown as typeof fetch;
  const r = await pushAll(
    v,
    db,
    noticeOf({ chat: "c-1", turn: "u-1", title: "Plan", body: "done", failed: false }),
    fetcher,
  );
  assertEquals(r, { sent: 1, removed: 1 });
  assertEquals(subs.all().map((s) => s.endpoint), ["https://push.example.net/send/abc"]);
  assert(seen[0].headers.get("authorization")!.startsWith("vapid t="));
  assertEquals([seen[0].headers.get("content-encoding"), seen[0].headers.get("ttl")], ["aes128gcm", "86400"]);
  assert(seen[0].len > 100);
  // a server error keeps the device
  assertEquals(
    await sendPush(v, subs.all()[0], {}, (() => Promise.resolve(new Response(null, { status: 500 }))) as never),
    "error",
  );
  assertEquals((await call("DELETE", "/api/push/subscriptions", { endpoint: sub().endpoint })).body, { ok: true });
  assertEquals(subs.all(), []);
});
