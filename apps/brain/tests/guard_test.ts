// Tests for what the service refuses in front of the handlers (guard.ts): bodies over their path's
// limit, declared or streamed.
import { assert, assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { bodyLimit, capped, isTooLarge, TooLarge } from "../guard.ts";

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
