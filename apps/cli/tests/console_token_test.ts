// Tests for the console's token (console/token.ts): who passes, the bootstrap that sets the cookie,
// the one-use ticket, the public allowlist, and where the token file goes.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  type Auth,
  cookieValue,
  gate,
  newToken,
  publishToken,
  sameSecret,
  setCookie,
  Tickets,
  tokenPath,
} from "../console/token.ts";
import { createHandler } from "../console/server.ts";

const auth = (): Auth => ({ token: "tok-123", tickets: new Tickets() });
const ask = (a: Auth, path: string, headers: Record<string, string> = {}, method = "GET") =>
  gate({ method, url: new URL(`http://127.0.0.1:7331${path}`), headers: new Headers(headers) }, a);

Deno.test("token: 32 random bytes, base64url, different every time", () => {
  const a = newToken(), b = newToken();
  assertEquals(a.length, 43);
  assert(/^[A-Za-z0-9_-]+$/.test(a));
  assertNotEquals(a, b);
});

Deno.test("token: the comparison needs the same value, whatever the length", () => {
  assert(sameSecret("abc", "abc"));
  assert(!sameSecret("abc", "abd"));
  assert(!sameSecret("abc", "abcd"));
  assert(!sameSecret("", "abc"));
});

Deno.test("token: a cookie is found among others, and only by its exact name", () => {
  assertEquals(cookieValue("a=1; agents_token=xyz; b=2", "agents_token"), "xyz");
  assertEquals(cookieValue("not_agents_token=xyz", "agents_token"), null);
  assertEquals(cookieValue(null, "agents_token"), null);
  assertEquals(setCookie("t"), "agents_token=t; HttpOnly; SameSite=Strict; Path=/");
});

Deno.test("token: the header or the cookie passes; nothing, or another value, is refused", () => {
  const a = auth();
  assertEquals(ask(a, "/api/tasks", { "x-agents-token": "tok-123" }).kind, "pass");
  assertEquals(ask(a, "/api/tasks", { cookie: "agents_token=tok-123" }).kind, "pass");
  assertEquals(ask(a, "/api/tasks", { "x-agents-token": "tok-124" }), { kind: "refuse", api: true });
  assertEquals(ask(a, "/api/events"), { kind: "refuse", api: true });
  assertEquals(ask(a, "/api/tasks", { "x-claude-multi": "1" }, "POST"), { kind: "refuse", api: true });
  assertEquals(ask(a, "/claude/fonts/x.woff2"), { kind: "refuse", api: false });
  assertEquals(ask(a, "/"), { kind: "refuse", api: false });
});

Deno.test("token: only the liveness probe is public, and only to read", () => {
  const a = auth();
  assertEquals(ask(a, "/api/code").kind, "pass");
  assertEquals(ask(a, "/api/code", {}, "POST"), { kind: "refuse", api: true });
  assertEquals(ask(a, "/api/code/x"), { kind: "refuse", api: true });
  assertEquals(ask(a, "/api/status"), { kind: "refuse", api: true });
});

Deno.test("token: the root with the token enters, and goes on to the same page without it", () => {
  const a = auth();
  assertEquals(ask(a, "/?k=tok-123"), { kind: "enter", to: "/" });
  assertEquals(ask(a, "/?x=1&k=tok-123"), { kind: "enter", to: "/?x=1" });
  assertEquals(ask(a, "/?k=wrong"), { kind: "refuse", api: false });
  // the key opens the page and nothing else
  assertEquals(ask(a, "/api/tasks?k=tok-123"), { kind: "refuse", api: true });
  assertEquals(ask(a, "/?k=tok-123", {}, "POST"), { kind: "refuse", api: false });
});

Deno.test("token: a ticket opens the page once, and only for a minute", () => {
  const a = auth();
  const t = a.tickets.issue(1000);
  assert(!a.tickets.redeem("other", 1000));
  assert(a.tickets.redeem(t, 2000));
  assert(!a.tickets.redeem(t, 2000)); // spent
  const late = a.tickets.issue(1000);
  assert(!a.tickets.redeem(late, 1000 + 60_001));
  assertEquals(ask(a, `/?k=${a.tickets.issue()}`).kind, "enter");
});

Deno.test("token: the handler answers 401 without the key, sets the cookie on the bootstrap, and hides nothing behind the allowlist", async () => {
  const a = auth();
  const dist = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${dist}/index.html`, "<!doctype html>");
  const handle = createHandler(
    {
      "/api/code": { get: () => Response.json({ code: "c" }) },
      "/api/tasks": { get: () => Response.json([]) },
    },
    a,
    dist,
  );
  const req = (path: string, headers: Record<string, string> = {}) =>
    handle(new Request(`http://127.0.0.1:7331${path}`, { headers: { host: "127.0.0.1:7331", ...headers } }));

  assertEquals((await req("/api/code")).status, 200);
  const denied = await req("/api/tasks");
  assertEquals([denied.status, await denied.json()], [401, { error: "unauthorized" }]);
  const page = await req("/");
  assertEquals(page.status, 401);
  assert((await page.text()).includes("agents serve"));

  const entered = await req("/?k=tok-123");
  assertEquals([entered.status, entered.headers.get("location")], [303, "/"]);
  assertEquals(entered.headers.get("set-cookie"), setCookie("tok-123"));
  assertEquals((await req("/", { cookie: "agents_token=tok-123" })).status, 200);
});

Deno.test("token: the file is in the runtime folder, else the state folder, one per port", () => {
  assertEquals(tokenPath(7331, { XDG_RUNTIME_DIR: "/run/user/1" }), "/run/user/1/agents-multi-console.token");
  assertEquals(tokenPath(7400, { XDG_RUNTIME_DIR: "/run/user/1" }), "/run/user/1/agents-multi-console.7400.token");
  assertEquals(tokenPath(7331, { HOME: "/h" }), "/h/.local/state/agents-multi/agents-multi-console.token");
  assertEquals(
    tokenPath(7331, { HOME: "/h", XDG_STATE_HOME: "/s" }),
    "/s/agents-multi/agents-multi-console.token",
  );
});

Deno.test("token: published for the user alone in a private folder, and removed", async () => {
  const root = Deno.makeTempDirSync();
  const path = tokenPath(7331, { XDG_STATE_HOME: root });
  const remove = await publishToken(path, "secret");
  assertEquals(await Deno.readTextFile(path), "secret");
  assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  assertEquals((await Deno.stat(`${root}/agents-multi`)).mode! & 0o777, 0o700);
  remove();
  assertEquals(await Deno.stat(path).catch(() => null), null);
  remove(); // twice is fine
});
