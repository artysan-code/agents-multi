// The pure parts of the lazy MCP gateway (docs/adr/0008): routing, tokens, cache keys, idle logic, and
// the launch config the CLI makes for it. Profile names come from the fixture configuration, never literals.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { backendEnv } from "../../../shared/mcp/gateway/backend.ts";
import { gatewayDenyRules, runtimeNames } from "../mcp/gateway-settings.ts";
import { permissionRules } from "../mcp/placement.ts";
import { serverDirOf } from "../codeversion.ts";
import {
  bearer,
  cacheFile,
  cacheKey,
  type GatewayConfig,
  idleCheckIn,
  idleDue,
  localRequest,
  parsePath,
  rotateNeeded,
  sameBackend,
  startTimeOf,
  TokenMap,
  toolAllowed,
  usableCache,
  visibleTools,
} from "../../../shared/mcp/gateway/core.ts";
import {
  backendSpec,
  gatewayCommand,
  gatewayConfig,
  launchServers,
  staleCacheFiles,
  viaGateway,
} from "../mcp/gateway.ts";
import { gatewaySettings } from "../mcp/gateway-settings.ts";
import { codexToolsConfig, launchConfig } from "../mcp/config.ts";
import { type Registry } from "../mcp/registry.ts";
import { profileNames } from "../lib/profiles.ts";
import { gatewayTokenProblem } from "../doctor/checks/gateway.ts";
import { isGatewayCmdline } from "../console/gateway.ts";

const [A, B] = await profileNames();

Deno.test("parsePath: /p/<profile>/<server>, nothing else", () => {
  assertEquals(parsePath("/p/work/n8n-main"), { profile: "work", server: "n8n-main" });
  assertEquals(parsePath("/p/work/google/"), { profile: "work", server: "google" });
  for (const bad of ["/", "/p/work", "/p/work/x/y", "/p//x", "/q/work/x", "/p/wo rk/x", "/p/../x", "/p/a/b/../c"]) {
    assertEquals(parsePath(bad), null, bad);
  }
});

Deno.test("TokenMap: a token opens its own profile's paths, another's are forbidden", () => {
  const m = new TokenMap();
  m.set(A, "tok-a");
  m.set(B, "tok-b");
  assertEquals(m.check("tok-a", A), "ok");
  assertEquals(m.check("tok-a", B), "forbidden");
  assertEquals(m.check("tok-b", A), "forbidden");
  assertEquals(m.check("nope", A), "unauthorized");
  assertEquals(m.check(null, A), "unauthorized");
  assertEquals(m.check("", A), "unauthorized");
  // an unreadable token file (empty) leaves the profile without access
  m.set(A, "");
  assertEquals(m.check("tok-a", A), "unauthorized");
});

Deno.test("bearer: only a well-formed Bearer header", () => {
  assertEquals(bearer("Bearer abc-DEF_123"), "abc-DEF_123");
  assertEquals(bearer("bearer abc"), "abc");
  assertEquals(bearer("Basic abc"), null);
  assertEquals(bearer("Bearer a b"), null);
  assertEquals(bearer(null), null);
});

Deno.test("localRequest: the Host names this listener and a browser's Origin is refused", () => {
  assert(localRequest("127.0.0.1:7332", null, 7332));
  assert(!localRequest("[::1]:7332", null, 7332)); // the listener is IPv4 loopback only
  assert(localRequest("localhost:7332", null, 7332));
  assert(!localRequest("evil.example:7332", null, 7332));
  assert(!localRequest("127.0.0.1:9999", null, 7332));
  assert(!localRequest("127.0.0.1:7332", "https://evil.example", 7332));
  assert(!localRequest(null, null, 7332));
});

Deno.test("cacheKey: the name, how it is started (tool filters) and the version make the list another one", async () => {
  const spec = { command: "node", args: ["n8n-mcp"], env: { DISABLED_TOOLS: "a,b", MODE: "stdio" } };
  const k = await cacheKey("n8n-x", spec, "2.92.1");
  assertEquals(k, await cacheKey("n8n-x", { ...spec, env: { MODE: "stdio", DISABLED_TOOLS: "a,b" } }, "2.92.1")); // env order
  assertNotEquals(k, await cacheKey("n8n-y", spec, "2.92.1"));
  assertNotEquals(k, await cacheKey("n8n-x", spec, "2.93.0"));
  assertNotEquals(k, await cacheKey("n8n-x", { ...spec, env: { ...spec.env, DISABLED_TOOLS: "a" } }, "2.92.1"));
  assertNotEquals(k, await cacheKey("n8n-x", { ...spec, args: ["n8n-mcp", "--x"] }, "2.92.1"));
  assertEquals(k.length, 16);
});

Deno.test("usableCache: only the list of this key", () => {
  const ok = { key: "k1", at: "x", tools: [{ name: "t" }] };
  assertEquals(usableCache(ok, "k1"), ok);
  assertEquals(usableCache(ok, "k2"), null);
  assertEquals(usableCache({ key: "k1" }, "k1"), null);
  assertEquals(usableCache(null, "k1"), null);
  assertEquals(cacheFile("/c", "tasks", "k1"), "/c/tasks-k1.json");
});

Deno.test("idle: nothing in flight and long enough since the last work", () => {
  const idle = 600_000;
  assert(!idleDue({ inflight: 0, lastUsed: 1000 }, 1000 + idle - 1, idle));
  assert(idleDue({ inflight: 0, lastUsed: 1000 }, 1000 + idle, idle));
  assert(!idleDue({ inflight: 1, lastUsed: 0 }, 10 * idle, idle)); // a call still running keeps it
  assertEquals(idleCheckIn({ inflight: 0, lastUsed: 1000 }, 1000 + 100, idle), idle - 100);
  assertEquals(idleCheckIn({ inflight: 0, lastUsed: 0 }, 10 * idle, idle), 1000); // never a busy loop
});

Deno.test("sameBackend: a running one stays only while the registry's key is the same", () => {
  assert(sameBackend({ key: "a" }, { key: "a" }));
  assert(!sameBackend({ key: "a" }, { key: "b" }));
  assert(!sameBackend(null, { key: "a" }));
  assert(!sameBackend({ key: "a" }, undefined));
});

// ------------------------------------------------------------------------------ the CLI's side
const G = gatewaySettings({}, "app", "/rt", undefined);
const stdio = (extra: Record<string, unknown> = {}) => ({ command: "deno", args: ["run", "s.ts"], ...extra });
const reg = (over: Partial<Registry> = {}): Registry => ({
  profiles: [A, B],
  gateway: G,
  servers: {
    tasks: stdio({ env: { X: "1" } }),
    hub: stdio({ _gateway: false }),
    bound: stdio({ _bind: { project: "--p={value}" } }),
    remote: { type: "http", url: "https://r.example/mcp" },
    npmsrv: { command: "node", args: ["/t/bin/x"], _npm: { package: "x", version: "1.2.3", bin: "x" } },
  },
  ...over,
});

Deno.test("gatewaySettings: on in app mode, off in dev, the file decides, numbers are bounded", () => {
  assertEquals(gatewaySettings(null, "app", "/rt").enabled, true);
  assertEquals(gatewaySettings(null, "dev", "/rt").enabled, false);
  assertEquals(gatewaySettings({ enabled: false }, "app", "/rt").enabled, false);
  assertEquals(gatewaySettings({ enabled: true }, "dev", "/rt").enabled, true);
  const d = gatewaySettings(null, "app", "/rt");
  assertEquals([d.port, d.idleMs], [7332, 600_000]);
  const c = gatewaySettings({ idleMinutes: 3, port: 8123 }, "app", "/rt");
  assertEquals([c.port, c.idleMs], [8123, 180_000]);
  assertEquals(gatewaySettings({ idleMinutes: 0, port: 80 }, "app", "/rt").idleMs, 600_000);
  assertEquals(gatewaySettings({ port: 80 }, "app", "/rt").port, 7332);
  assertEquals(gatewaySettings({ port: 8123 }, "app", "/rt", "9000").port, 9000); // the environment wins
  assertEquals(d.headers, "/rt/shared/mcp/gateway/headers.sh");
});

Deno.test("viaGateway: commands go, the hub, bound and remote servers do not", () => {
  const r = reg();
  assert(viaGateway(r.servers.tasks, r.servers.tasks));
  assert(!viaGateway(r.servers.hub, r.servers.hub));
  assert(!viaGateway(r.servers.bound, r.servers.bound));
  assert(!viaGateway(r.servers.remote, r.servers.remote));
});

Deno.test("launchServers: the same names, http through the gateway, the token only by file", () => {
  const out = launchServers(reg(), A);
  assertEquals(Object.keys(out).sort(), ["bound", "hub", "npmsrv", "remote", "tasks"]);
  assertEquals(out.tasks, {
    type: "http",
    url: `http://127.0.0.1:7332/p/${A}/tasks`,
    headersHelper: `bash /rt/shared/mcp/gateway/headers.sh /rt/${A}/mcp-token`,
  });
  assertEquals((out.npmsrv as { type: string }).type, "http");
  assertEquals(out.hub, { command: "deno", args: ["run", "s.ts"] }); // `_` keys never reach a config
  assertEquals(out.remote, { type: "http", url: "https://r.example/mcp" });
  assertEquals(Object.keys(out.bound), ["command", "args"]);
  assert(!JSON.stringify(out).includes("Bearer"));
});

Deno.test("launchServers: the kill switch gives the plain stdio entries back", () => {
  const off = reg({ gateway: { ...G, enabled: false } });
  const plain = launchServers(off, A);
  assertEquals(plain.tasks, { command: "deno", args: ["run", "s.ts"], env: { X: "1" } });
  assertEquals(launchServers(reg({ gateway: undefined }), A), plain);
  // and the config text follows
  assert(launchConfig(off, A).includes('"command": "deno"'));
  assert(launchConfig(reg(), A).includes('"headersHelper"'));
});

Deno.test("codexToolsConfig: of each server only its _allow tools, none for a server without any", () => {
  const r = reg({
    servers: { tasks: stdio({ _allow: ["tasks_list", "tasks_brief"] }), hub: stdio({ _ask: ["x"] }), other: stdio() },
  });
  assertEquals(JSON.parse(codexToolsConfig(r, A)), { tools: { tasks: ["tasks_brief", "tasks_list"] } });
});

Deno.test("gatewayConfig: each profile its token file and the servers behind the gateway, keyed", async () => {
  const cfg = await gatewayConfig(reg(), () => Promise.resolve("code1"));
  assertEquals(cfg.port, 7332);
  assertEquals(cfg.idleMs, 600_000);
  assertEquals(Object.keys(cfg.profiles[A].servers).sort(), ["npmsrv", "tasks"]);
  assertEquals(cfg.profiles[A].tokenFile, `/rt/${A}/mcp-token`);
  assertEquals(backendSpec(reg().servers.tasks), { command: "deno", args: ["run", "s.ts"], env: { X: "1" } });
  const t = cfg.profiles[A].servers.tasks;
  assertEquals(t.command, "deno");
  // our servers key on the code's version, an npm one on the package's
  const next = await gatewayConfig(reg(), () => Promise.resolve("code2"));
  assertNotEquals(next.profiles[A].servers.tasks.key, t.key);
  assertEquals(next.profiles[A].servers.npmsrv.key, cfg.profiles[A].servers.npmsrv.key);
  // the same spec in another profile is another entry (its own env says whose it is)
  assert(JSON.stringify(cfg).indexOf("secret") < 0);
});

Deno.test("staleCacheFiles: the lists no entry names any more", () => {
  const cfg: GatewayConfig = {
    port: 1,
    idleMs: 1,
    profiles: { p: { tokenFile: "/t", servers: { tasks: { command: "c", args: [], env: {}, key: "new" } } } },
  };
  assertEquals(staleCacheFiles(["tasks-new.json", "tasks-old.json", "gone-x.json", "x.tmp"], cfg), [
    "tasks-old.json",
    "gone-x.json",
  ]);
});

Deno.test("gatewayCommand: loopback only, its folder the only place it writes", () => {
  const cmd = gatewayCommand(G, "/rt/bin/deno", "/home/u");
  assert(cmd.includes("--allow-net=127.0.0.1:7332"));
  assert(cmd.includes("--allow-write=/rt/gateway"));
  assert(cmd.includes("--allow-read=/rt,/home/u/.cache/deno"));
  assertEquals(cmd.slice(-2), ["/rt/shared/mcp/gateway/server.ts", "/rt/gateway/backends.json"]);
});

Deno.test("gatewayTokenProblem: missing is a wait, readable by others is a failure", () => {
  assertEquals(gatewayTokenProblem("/t", 0o100600), null);
  assertEquals(gatewayTokenProblem("/t", null)?.status, "warn");
  const open = gatewayTokenProblem("/t", 0o100644);
  assertEquals(open?.status, "fail");
  assertEquals(open?.fix, "chmod 600 /t");
});

Deno.test("isGatewayCmdline: only the gateway's own server script", () => {
  assert(isGatewayCmdline("/rt/bin/deno\0run\0--quiet\0/rt/shared/mcp/gateway/server.ts\0/rt/gateway/backends.json\0"));
  assert(!isGatewayCmdline("/rt/bin/deno\0run\0/rt/shared/mcp/tasks/server.ts\0"));
  assert(!isGatewayCmdline(""));
});

Deno.test("_deny: the gateway neither lists nor forwards a denied tool", () => {
  const tools = [{ name: "a" }, { name: "n8n_delete_workflow" }, { name: "b" }];
  assertEquals(visibleTools(tools, ["n8n_delete_workflow"]).map((t) => t.name), ["a", "b"]);
  assertEquals(visibleTools(tools, undefined), tools);
  assert(!toolAllowed(["n8n_delete_workflow"], "n8n_delete_workflow"));
  assert(toolAllowed(["n8n_delete_workflow"], "n8n_list_workflows"));
  assert(toolAllowed(undefined, "anything"));
});

Deno.test("gatewayConfig: the registry's _deny and our server's own folder reach the gateway", async () => {
  const r = reg();
  r.servers.tasks = stdio({
    args: ["run", "/h/.agents-multi/shared/mcp/tasks/server.ts"],
    _deny: ["zz", "aa"],
  });
  const seen: (string | null)[] = [];
  const cfg = await gatewayConfig(r, (dir) => {
    seen.push(dir);
    return Promise.resolve(dir ?? "none");
  });
  assertEquals(cfg.profiles[A].servers.tasks.deny, ["aa", "zz"]);
  assertEquals(cfg.profiles[A].servers.npmsrv.deny, undefined);
  assert(seen.includes("tasks"));
  // a change of tasks' code is another key; none of anything else's is
  const other = await gatewayConfig(r, (dir) => Promise.resolve(dir === "tasks" ? "changed" : "none"));
  assertNotEquals(other.profiles[A].servers.tasks.key, cfg.profiles[A].servers.tasks.key);
});

Deno.test("serverDirOf: the folder under shared/mcp a command of ours runs", () => {
  assertEquals(serverDirOf(["run", "--quiet", "/h/.agents-multi/shared/mcp/google/server.ts"]), "google");
  assertEquals(serverDirOf(["run", "/h/.agents-multi/shared/mcp/syncthing-status/server.ts"]), "syncthing-status");
  assertEquals(serverDirOf(["/t/node_modules/.bin/n8n-mcp"]), null);
  assertEquals(serverDirOf([]), null);
});

Deno.test("startTimeOf: the start time in /proc/<pid>/stat, whatever the command's name holds", () => {
  const stat = (comm: string) =>
    `123 (${comm}) S 1 123 123 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100 18446744073709551615`;
  assertEquals(startTimeOf(stat("deno")), "987654");
  assertEquals(startTimeOf(stat("a) S 9 (b")), "987654");
  assertEquals(startTimeOf(""), null);
});

Deno.test("rotateNeeded and backendEnv", () => {
  assert(!rotateNeeded(10, 5, 15));
  assert(rotateNeeded(10, 6, 15));
  const spec = { command: "c", args: [], env: { AGENTS_MULTI_PROFILE: "p", X: "1" } };
  const env = backendEnv(
    { HOME: "/h", PATH: "/bin", CLAUDE_CONFIG_DIR: "/rt/other", CLAUDE_CODE_SESSION_ID: "s", CLAUDECODE: "1", X: "0" },
    spec,
  );
  assertEquals(env, { HOME: "/h", PATH: "/bin", AGENTS_MULTI_PROFILE: "p", X: "1" }); // no profile inherited
});

Deno.test("gatewayDenyRules: from the port that is really used, every name of the runtime", () => {
  const rules = gatewayDenyRules(7401, runtimeNames("/home/u/.agents-multi", "/home/u"));
  assert(rules.includes("Bash(*:7401*)"));
  assert(!rules.some((r) => r.includes("7332")));
  assert(rules.includes("Read(~/.claude-multi/*/mcp-token)"));
  assert(rules.includes("Read(~/.agents-multi/*/mcp-token)"));
  assert(rules.includes("Bash(*headers.sh*)"));
  assertEquals(runtimeNames("/data/rt", "/home/u")[0], "//data/rt");
});

Deno.test("permissionRules: the gateway's deny rules ride the profile's settings while it is on", () => {
  const on = permissionRules(reg(), A).deny;
  assert(on.includes("Bash(*:7332*)"));
  assertEquals(on, [...new Set(on)].sort());
  assert(!permissionRules(reg({ gateway: { ...G, enabled: false } }), A).deny.some((r) => r.includes("mcp-t")));
});
