// The gateway's server (shared/mcp/gateway/gateway.ts) against a fake stdio backend: shared starts, a
// failing or damaged cache, an entry replaced mid-start, the registry's _deny, who may ask, idle stop, and a
// gateway killed hard. Real processes and real HTTP on a free loopback port.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { startGateway } from "../../../shared/mcp/gateway/gateway.ts";
import { listProcesses } from "../../../shared/mcp/lib/platform.ts";
import { cacheFile, type GatewayConfig, type ServerEntry } from "../../../shared/mcp/gateway/core.ts";

const FAKE = new URL("./fixtures/fake-mcp.ts", import.meta.url).pathname;
const SERVER = new URL("../../../shared/mcp/gateway/server.ts", import.meta.url).pathname;
const OPTS = { sanitizeOps: false, sanitizeResources: false, sanitizeExit: false };

const freePort = () => {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
};
const until = async (what: string, ok: () => boolean | Promise<boolean>, ms = 8000) => {
  const t0 = Date.now();
  while (!await ok()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** What the tests read of a JSON-RPC answer. */
interface Body {
  result?: { tools: { name: string }[]; content: { text: string }[]; isError?: boolean };
  error?: unknown;
}

interface Harness {
  dir: string;
  port: number;
  config: GatewayConfig;
  lines(): string[];
  count(prefix: string): number;
  write(entry: Partial<ServerEntry>, env?: Record<string, string>): Promise<void>;
  rpc(
    method: string,
    params?: unknown,
    o?: { path?: string; token?: string | null; headers?: Record<string, string> },
  ): Promise<{ status: number; body: Body }>;
  stop(): Promise<void>;
}

/** A gateway on a free port with profile `p` (token `tok-p`) and `q` (token `tok-q`), one server `fake` each. */
async function harness(
  entry: Partial<ServerEntry> = {},
  env: Record<string, string> = {},
  idleMs = 60_000,
  inProcess = true,
) {
  const dir = await Deno.makeTempDir({ prefix: "gw-test-" });
  const port = freePort();
  const logFile = `${dir}/fake.log`;
  await Deno.writeTextFile(`${dir}/p.token`, "tok-p\n");
  await Deno.writeTextFile(`${dir}/q.token`, "tok-q\n");
  const server = (): ServerEntry => ({
    command: Deno.execPath(),
    args: ["run", "-A", "--no-lock", FAKE],
    env: { FAKE_LOG: logFile, ...env },
    key: "k1",
    ...entry,
  });
  const config: GatewayConfig = {
    port,
    idleMs,
    profiles: {
      p: { tokenFile: `${dir}/p.token`, servers: { fake: server() } },
      q: { tokenFile: `${dir}/q.token`, servers: { fake: server() } },
    },
  };
  const configPath = `${dir}/backends.json`;
  const save = () => Deno.writeTextFile(configPath, JSON.stringify(config));
  await save();
  const gw = inProcess ? await startGateway({ configPath, log: () => {}, drainMs: 3000 }) : null;
  let id = 0;
  const h: Harness = {
    dir,
    port,
    config,
    lines: () => {
      try {
        return Deno.readTextFileSync(logFile).split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    count: (prefix) => h.lines().filter((l) => l.startsWith(prefix)).length,
    async write(patch, e) {
      config.profiles.p.servers.fake = { ...server(), ...patch, env: { FAKE_LOG: logFile, ...(e ?? env) } };
      await save();
      await Deno.utime(configPath, new Date(), new Date(Date.now() + ++id * 1000));
    },
    async rpc(method, params, o = {}) {
      const token = o.token === undefined ? "tok-p" : o.token;
      const r = await fetch(`http://127.0.0.1:${port}${o.path ?? "/p/p/fake"}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...o.headers,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? {} }),
      });
      const t = await r.text();
      return { status: r.status, body: (t ? JSON.parse(t) : {}) as Body };
    },
    async stop() {
      await gw?.shutdown();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
  return h;
}
const call = (h: Harness, name: string, args: unknown = {}, o = {}) =>
  h.rpc("tools/call", { name, arguments: args }, o);

Deno.test({
  name: "two first calls at once start one backend, and a later call from another session shares it",
  ...OPTS,
  fn: async () => {
    const h = await harness();
    try {
      const [a, b] = await Promise.all([call(h, "echo", { text: "a" }), call(h, "echo", { text: "b" })]);
      assertEquals(a.body.result!.content[0].text, "echo:a");
      assertEquals(b.body.result!.content[0].text, "echo:b");
      assertEquals(h.count("start"), 1);
      await call(h, "echo");
      assertEquals(h.count("start"), 1);
      assertEquals(h.count("call echo"), 3);
    } finally {
      await h.stop();
    }
  },
});

Deno.test({
  name: "tools/list: a backend that does not start is an error, not an empty list; the next try works",
  ...OPTS,
  fn: async () => {
    const h = await harness({}, { FAKE_FAIL: "1" });
    try {
      const bad = await h.rpc("tools/list");
      assert(bad.body.error, "an error answer");
      assertEquals(bad.body.result, undefined);
      await h.write({}, {}); // repaired
      const ok = await h.rpc("tools/list");
      assertEquals(ok.body.result!.tools.map((t) => t.name).sort(), ["danger", "echo", "slow"]);
      // and it was cached: the next list starts nothing
      const starts = h.count("start");
      await h.rpc("tools/list");
      assertEquals(h.count("start"), starts);
    } finally {
      await h.stop();
    }
  },
});

Deno.test({
  name: "a damaged cache is no cache: tools/list and tools/call still answer, and the file is made good",
  ...OPTS,
  fn: async () => {
    const h = await harness();
    try {
      const file = cacheFile(`${h.dir}/cache`, "fake", "k1");
      await Deno.mkdir(`${h.dir}/cache`, { recursive: true });
      await Deno.writeTextFile(file, '{"key":"k1","tools":[{"name":"ec');
      assertEquals((await call(h, "echo", { text: "x" })).body.result!.content[0].text, "echo:x");
      const list = await h.rpc("tools/list");
      assertEquals(list.body.result!.tools.length, 3);
      assertEquals(JSON.parse(await Deno.readTextFile(file)).tools.length, 3);
    } finally {
      await h.stop();
    }
  },
});

Deno.test({
  name: "an entry replaced while its backend is starting: the old one finishes its call and stops, the new one serves",
  ...OPTS,
  fn: async () => {
    const h = await harness({}, { FAKE_DELAY: "700" });
    try {
      const first = call(h, "echo", { text: "old" });
      await until("the first start", () => h.count("start") === 1);
      await h.write({ key: "k2" }, {}); // no delay: the replacement is quick
      const second = await call(h, "echo", { text: "new" });
      assertEquals(second.body.result!.content[0].text, "echo:new");
      assertEquals((await first).body.result!.content[0].text, "echo:old"); // not cut
      await until("the old backend to stop", () => h.count("exit") >= 1);
      assertEquals(h.count("start"), 2);
      const status = await h.rpc("x", {}, { path: "/status" }).catch(() => null);
      assertNotEquals(status, null);
    } finally {
      await h.stop();
    }
  },
});

Deno.test({
  name: "_deny: not listed, not forwarded, and refusing does not start the backend",
  ...OPTS,
  fn: async () => {
    const h = await harness({ deny: ["danger"] });
    try {
      const refused = await call(h, "danger");
      assertEquals(refused.body.result!.isError, true);
      assert(refused.body.result!.content[0].text.includes("denied"));
      assertEquals(h.count("start"), 0);
      const list = await h.rpc("tools/list");
      assertEquals(list.body.result!.tools.map((t) => t.name).sort(), ["echo", "slow"]);
      assertEquals(h.count("call danger"), 0);
    } finally {
      await h.stop();
    }
  },
});

Deno.test({
  name:
    "who may ask: no token 401, another profile's token 403, a browser's Origin 403, /health says nothing, /status needs a token",
  ...OPTS,
  fn: async () => {
    const h = await harness();
    try {
      assertEquals((await h.rpc("tools/list", {}, { token: null })).status, 401);
      assertEquals((await h.rpc("tools/list", {}, { token: "nope" })).status, 401);
      assertEquals((await h.rpc("tools/list", {}, { token: "tok-q" })).status, 403);
      assertEquals((await h.rpc("tools/list", {}, { path: "/p/q/fake", token: "tok-q" })).status, 200);
      assertEquals((await h.rpc("tools/list", {}, { path: "/p/p/nope" })).status, 404);
      assertEquals((await h.rpc("tools/list", {}, { headers: { origin: "https://evil.example" } })).status, 403);
      const health = await fetch(`http://127.0.0.1:${h.port}/health`);
      assertEquals(await health.json(), { gateway: true });
      assertEquals((await fetch(`http://127.0.0.1:${h.port}/status`)).status === 401, true);
      const st = await fetch(`http://127.0.0.1:${h.port}/status`, { headers: { authorization: "Bearer tok-q" } });
      assertEquals((await st.json()).gateway, true);
      assertEquals(
        (await fetch(`http://127.0.0.1:${h.port}/p/p/fake`, { headers: { authorization: "Bearer tok-p" } })).status,
        405,
      );
    } finally {
      await h.stop();
    }
  },
});

Deno.test({
  name: "idle: the backend stops when nothing uses it, and starts again on the next call",
  ...OPTS,
  fn: async () => {
    const h = await harness({}, {}, 400);
    try {
      await call(h, "echo");
      assertEquals(h.count("start"), 1);
      await until("the idle stop", () => h.count("exit") === 1, 5000);
      await call(h, "echo");
      assertEquals(h.count("start"), 2);
    } finally {
      await h.stop();
    }
  },
});

const alive = (pid: number) => listProcesses().has(pid); // a zombie is left out of the table

Deno.test({
  name: "a gateway killed hard leaves no backend behind once the next one starts",
  ...OPTS,
  fn: async () => {
    const h = await harness({}, { FAKE_LINGER: "1" }, 60_000, false);
    const run = () =>
      new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-lock", SERVER, `${h.dir}/backends.json`],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
    const up = async () => {
      await until(
        "the gateway",
        async () => await fetch(`http://127.0.0.1:${h.port}/health`).then((r) => r.ok, () => false),
      );
    };
    let gw = run();
    try {
      await up();
      await call(h, "echo");
      const pid = Number(h.lines().find((l) => l.startsWith("start"))!.split(" ")[1]);
      assert(await alive(pid));
      gw.kill("SIGKILL");
      await gw.status;
      assert(await alive(pid), "a server that does not notice its stdin closing is left behind");
      gw = run();
      await up();
      await until("the orphan to be gone", async () => !await alive(pid), 5000);
      assertEquals(h.count("start"), 1);
    } finally {
      try {
        gw.kill("SIGTERM");
        await gw.status;
      } catch { /* already gone */ }
      await h.stop();
    }
  },
});
