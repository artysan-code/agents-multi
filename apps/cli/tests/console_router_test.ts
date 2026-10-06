// Tests for the console's request handler (console/server.ts): the local-host guard, the anti-CSRF
// header on writes, 405 on a POST-only path, the table before the static files.
import { assertEquals } from "jsr:@std/assert@1";
import { createHandler, type Route } from "../console/server.ts";

const calls: string[] = [];
const table: Record<string, Route> = {
  "/api/code": { get: () => Response.json({ code: "abc" }) },
  "/api/write": {
    post: () => {
      calls.push("write");
      return Response.json({ ok: true });
    },
  },
  "/api/both": { get: () => new Response("got"), post: () => new Response("posted") },
};
const handle = createHandler(table);
const req = (path: string, init: RequestInit & { host?: string } = {}) =>
  new Request(`http://127.0.0.1:7331${path}`, {
    ...init,
    headers: { host: init.host ?? "127.0.0.1:7331", ...(init.headers as Record<string, string> ?? {}) },
  });

Deno.test("console router: a host that is not local is refused before anything runs", async () => {
  assertEquals((await handle(req("/api/code", { host: "evil.example:7331" }))).status, 403);
  assertEquals((await handle(req("/api/code", { host: "localhost:9000" }))).status, 200);
});

Deno.test("console router: writes need the anti-CSRF header; a POST-only path refuses GET", async () => {
  calls.length = 0;
  assertEquals((await handle(req("/api/write", { method: "POST" }))).status, 403);
  assertEquals(calls, []);
  const ok = await handle(req("/api/write", { method: "POST", headers: { "x-claude-multi": "1" } }));
  assertEquals([ok.status, calls], [200, ["write"]]);
  assertEquals((await handle(req("/api/write"))).status, 405);
});

Deno.test("console router: GET and POST on one path; a POST to a GET-only path reads", async () => {
  assertEquals(await (await handle(req("/api/both"))).text(), "got");
  assertEquals(
    await (await handle(req("/api/both", { method: "POST", headers: { "x-claude-multi": "1" } }))).text(),
    "posted",
  );
  assertEquals((await (await handle(req("/api/code", { method: "POST" }))).json()).code, "abc");
});

Deno.test("console router: unknown paths fall to the page's files, which refuse anything but flat names", async () => {
  assertEquals((await handle(req("/../../etc/passwd"))).status, 404);
  assertEquals((await handle(req("/vendor/../../x.js"))).status, 404);
  assertEquals((await handle(req("/index.html"))).status, 200);
});
