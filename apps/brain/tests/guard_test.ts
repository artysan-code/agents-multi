// Tests for what the service refuses in front of the handlers (guard.ts): bodies over their path's
// limit, declared or streamed; the client's address; the rate limit per address; the gate.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { bodyLimit, Buckets, capped, clientIp, Gate, isTooLarge, TooLarge } from "../guard.ts";

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://b.test/token", { method: "POST", body, headers });
const stream = (n: number, size: number) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(size));
      c.close();
    },
  });

Deno.test("guard: the sign-in and OAuth paths take small bodies, the rest a page's worth", () => {
  for (const p of ["/register", "/token", "/authorize", "/invite", "/account/login", "/account/admin/invite"]) {
    assertEquals(bodyLimit(p), 64 * 1024, p);
  }
  for (const p of ["/mcp", "/api/tasks/t-1", "/tasks/t-1/edit"]) assertEquals(bodyLimit(p), 1024 * 1024, p);
});

Deno.test("guard: a declared length over the limit is refused before anything is read", () => {
  assertThrows(() => capped(post("x", { "content-length": "11" }), 10), TooLarge);
});

Deno.test("guard: a body within the limit reads as it was sent", async () => {
  assertEquals(await capped(post("a=1&b=2"), 10).text(), "a=1&b=2");
  assertEquals((await capped(post(stream(2, 5)), 10).arrayBuffer()).byteLength, 10);
  const get = new Request("http://b.test/x");
  assertEquals(capped(get, 1), get);
});

Deno.test("guard: a stream that grows past the limit fails when read, and is known for what it is", async () => {
  const e = await assertRejects(() => capped(post(stream(3, 5)), 10).text());
  assert(isTooLarge(e), String(e));
  assert(!isTooLarge(new Error("other")));
  assert(isTooLarge(new TypeError("wrapped", { cause: new TooLarge(1) })));
});

Deno.test("guard: the client's address comes from the named header, its last entry, or the connection", () => {
  const h = new Headers({ "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "1.1.1.1, 198.51.100.2" });
  assertEquals(clientIp(h, "10.0.0.1", "cf-connecting-ip"), "203.0.113.9");
  assertEquals(clientIp(h, "10.0.0.1", "x-forwarded-for"), "198.51.100.2");
  assertEquals(clientIp(h, "10.0.0.1"), "10.0.0.1"); // no header named: a client cannot choose its address
  assertEquals(clientIp(new Headers(), "10.0.0.1", "cf-connecting-ip"), "10.0.0.1");
});

Deno.test("guard: a bucket lets a burst through, then one request per interval, per key", () => {
  const b = new Buckets(3, 1000);
  for (let i = 0; i < 3; i++) assertEquals(b.take("a", 0), 0);
  assertEquals(b.take("a", 0), 1);
  assertEquals(b.take("b", 0), 0, "another address has its own");
  assertEquals(b.take("a", 999), 1);
  assertEquals(b.take("a", 1999), 0, "refilled after the interval");
  assertEquals(b.take("a", 1999), 1);
});

Deno.test("guard: a gate runs `size` jobs at once, queues `queue` more, refuses the rest", async () => {
  const g = new Gate(1, 1);
  let release!: () => void;
  const held = new Promise<void>((r) => release = r);
  let running = 0, most = 0;
  const job = async () => {
    most = Math.max(most, ++running);
    await held;
    running--;
    return "done";
  };
  const first = g.run(job), second = g.run(job);
  assertEquals(await g.run(job), null, "a third waits nowhere: refused");
  release();
  assertEquals(await Promise.all([first, second]), ["done", "done"]);
  assertEquals(most, 1);
  assertEquals(await g.run(() => Promise.resolve(1)), 1, "free again once the line is empty");
});
