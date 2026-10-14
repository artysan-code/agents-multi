// gateway.ts — the lazy MCP gateway (docs/adr/0008): one process per machine on 127.0.0.1, one Streamable
// HTTP endpoint per (profile, server). A session lists a server's tools from a cache, so nothing is
// started when it opens; the stdio server behind the path starts on the first call, is shared by every
// session of that profile, and stops when it has been idle for a while. server.ts starts it; the tests
// (apps/cli/tests/gateway_server_test.ts) start it in-process.
//
// Stateless on purpose: no session ids, one MCP server object per request. A gateway that restarts loses
// nothing, and the client's next request is simply answered (it reconnects by itself).
import { Server } from "npm:@modelcontextprotocol/sdk@1.32.1/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "npm:@modelcontextprotocol/sdk@1.32.1/types.js";
import {
  type Activity,
  bearer,
  type CachedList,
  cacheFile,
  type Child,
  type GatewayConfig,
  idleCheckIn,
  idleDue,
  localRequest,
  parsePath,
  sameBackend,
  type ServerEntry,
  startTimeOf,
  TokenMap,
  toolAllowed,
  usableCache,
  visibleTools,
} from "./core.ts";
import { CALL_TIMEOUT_MS, describe, type Running, startBackend } from "./backend.ts";
import { writeAtomic } from "../lib/fs.ts";
import { readProc } from "./proc.ts";

/** How long a gateway asked to stop waits for the calls in flight (a deploy, a test run) before it cuts them. */
export const DRAIN_MS = 60_000;

interface Slot {
  id: string;
  key: string;
  running: Running | null;
  starting: Promise<Running> | null;
  act: Activity;
  timer: ReturnType<typeof setTimeout> | null;
  /** replaced by a newer entry: it stops as soon as nothing is in flight */
  retired: boolean;
}
interface CallReq {
  params: { name: string; arguments?: Record<string, unknown> };
}

export interface GatewayOptions {
  /** the `backends.json` the CLI writes (its folder also holds cache/, children.json, state.json) */
  configPath: string;
  log: (line: string) => void;
  /** what /proc says about the gateway's own code: told to whoever asks, so a console can tell it is old */
  code?: string;
  drainMs?: number;
}
export interface Gateway {
  port: number;
  /** stops listening, waits for the calls in flight (up to drainMs), then stops every backend */
  shutdown(): Promise<void>;
  finished: Promise<void>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (t: string) => ({ content: [{ type: "text", text: t }], isError: true });

const procStart = async (pid: number) => startTimeOf(await readProc(pid, "stat"));

export async function startGateway(opts: GatewayOptions): Promise<Gateway> {
  const { configPath, log } = opts;
  const dir = configPath.replace(/\/[^/]*$/, "");
  const cacheDir = `${dir}/cache`;
  const drainMs = opts.drainMs ?? DRAIN_MS;

  // ── configuration: read again when the file changes ───────────────────────────────────────────
  let config: GatewayConfig | null = null;
  let configAt = 0;
  const tokens = new TokenMap();
  let tokensAt = 0;
  async function loadTokens() {
    tokensAt = Date.now();
    for (const [profile, p] of Object.entries(config?.profiles ?? {})) {
      tokens.set(profile, (await Deno.readTextFile(p.tokenFile).catch(() => "")).trim());
    }
  }
  async function current(): Promise<GatewayConfig> {
    const at = (await Deno.stat(configPath)).mtime?.getTime() ?? 0;
    if (!config || at !== configAt) {
      config = JSON.parse(await Deno.readTextFile(configPath)) as GatewayConfig;
      configAt = at;
      await loadTokens();
      log(`config: ${Object.keys(config.profiles).join(", ")}`);
    }
    return config;
  }

  // ── the backends it started, so a gateway killed hard can find them again ──────────────────────
  const childrenFile = `${dir}/children.json`;
  const children = new Map<number, Child>();
  const saveChildren = () => writeAtomic(childrenFile, JSON.stringify([...children.values()])).catch(() => {});
  async function reapOrphans() {
    let left: Child[] = [];
    try {
      left = JSON.parse(await Deno.readTextFile(childrenFile));
    } catch { /* none, or unreadable */ }
    for (const c of left) {
      // the same pid with the same start time: the process we started, still there
      if (!c.start || await procStart(c.pid) !== c.start) continue;
      try {
        Deno.kill(c.pid, "SIGTERM");
        log(`orphan ${c.name} pid=${c.pid} from a gateway that died: stopped`);
      } catch { /* gone meanwhile */ }
    }
    await Deno.remove(childrenFile).catch(() => {});
  }

  // ── slots ──────────────────────────────────────────────────────────────────────────────────────
  const slots = new Map<string, Slot>();

  /** Stops a slot's backend, also one that is still starting (it is waited for, then closed). */
  async function stopSlot(slot: Slot, why: string) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    if (slot.starting) await slot.starting.catch(() => {});
    const r = slot.running;
    slot.running = null;
    if (!r) return;
    log(`stop ${slot.id} pid=${r.pid} (${why})`);
    if (r.pid) children.delete(r.pid);
    void saveChildren();
    await r.close();
  }

  function watchIdle(slot: Slot, idleMs: number) {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = setTimeout(() => {
      slot.timer = null;
      if (!slot.running) return;
      if (idleDue(slot.act, Date.now(), idleMs)) void stopSlot(slot, `idle ${Math.round(idleMs / 1000)}s`);
      else watchIdle(slot, idleMs);
    }, idleCheckIn(slot.act, Date.now(), idleMs));
  }

  function slotFor(profile: string, name: string, entry: ServerEntry): Slot {
    const id = `${profile}/${name}`;
    const have = slots.get(id);
    if (have && sameBackend(have, entry)) return have;
    if (have) {
      // another start command or version: calls in flight finish on the old one, which stops after them
      have.retired = true;
      if (have.act.inflight === 0) void stopSlot(have, "its entry changed");
    }
    const slot: Slot = {
      id,
      key: entry.key,
      running: null,
      starting: null,
      act: { inflight: 0, lastUsed: Date.now() },
      timer: null,
      retired: false,
    };
    slots.set(id, slot);
    return slot;
  }

  /** The running backend of a slot, started if need be (concurrent first calls share one start). */
  function ensure(slot: Slot, entry: ServerEntry, idleMs: number): Promise<Running> {
    if (slot.running) return Promise.resolve(slot.running);
    return slot.starting ??= (async () => {
      const t0 = Date.now();
      try {
        const r = await startBackend(entry, Deno.env.toObject(), (l) => log(`[${slot.id}] ${l}`));
        slot.running = r;
        if (r.pid) {
          children.set(r.pid, { pid: r.pid, start: await procStart(r.pid) ?? "", name: slot.id });
          void saveChildren();
        }
        log(`start ${slot.id} pid=${r.pid} in ${Date.now() - t0}ms`);
        void r.gone.then(() => {
          if (slot.running === r) {
            slot.running = null;
            if (slot.timer) clearTimeout(slot.timer);
            slot.timer = null;
            if (r.pid) children.delete(r.pid);
            void saveChildren();
            log(`gone ${slot.id} pid=${r.pid}`);
          }
        });
        watchIdle(slot, idleMs);
        return r;
      } finally {
        slot.starting = null;
      }
    })();
  }

  /** Runs `fn` on the slot's backend, counting it as work (the idle clock and a replacement wait for it). */
  async function withBackend<T>(
    slot: Slot,
    entry: ServerEntry,
    idleMs: number,
    fn: (r: Running) => Promise<T>,
  ): Promise<T> {
    slot.act.inflight++;
    try {
      return await fn(await ensure(slot, entry, idleMs));
    } finally {
      slot.act.inflight--;
      slot.act.lastUsed = Date.now();
      if (slot.retired && slot.act.inflight === 0) void stopSlot(slot, "replaced");
      else if (slot.running) watchIdle(slot, idleMs);
    }
  }

  async function readCache(name: string, entry: ServerEntry): Promise<CachedList | null> {
    try {
      return usableCache(JSON.parse(await Deno.readTextFile(cacheFile(cacheDir, name, entry.key))), entry.key);
    } catch {
      return null; // absent, truncated or not JSON: the same as no cache, rebuilt by the next start
    }
  }
  async function writeCache(name: string, entry: ServerEntry, list: { tools: unknown[]; instructions?: string }) {
    const body: CachedList = { key: entry.key, at: new Date().toISOString(), ...list };
    await Deno.mkdir(cacheDir, { recursive: true });
    await writeAtomic(cacheFile(cacheDir, name, entry.key), JSON.stringify(body));
  }

  // ── MCP ────────────────────────────────────────────────────────────────────────────────────────
  /** One MCP server object for one request: its answers come from the cache and from the shared backend. */
  async function mcpFor(profile: string, name: string, entry: ServerEntry, idleMs: number) {
    const slot = slotFor(profile, name, entry);
    const cached = await readCache(name, entry);
    const server = new Server({ name, version: "1" }, {
      capabilities: { tools: {} },
      ...(cached?.instructions ? { instructions: cached.instructions } : {}),
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const hit = await readCache(name, entry);
      if (hit) return { tools: visibleTools(hit.tools as { name?: string }[], entry.deny) as never };
      // the cache is built by the first real start; this session is the one that pays for it. A failure is
      // the session's error (the server shows as failed and is tried again), never an empty list it would keep
      const list = await withBackend(slot, entry, idleMs, (r) => describe(r.client));
      await writeCache(name, entry, list).catch((e) => log(`cache ${name} not written: ${(e as Error).message}`));
      log(`cache ${name} (${list.tools.length} tools)`);
      return { tools: visibleTools(list.tools as { name?: string }[], entry.deny) as never };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req: CallReq, extra: { signal: AbortSignal }) => {
      if (!toolAllowed(entry.deny, req.params.name)) {
        log(`refused ${slot.id} ${req.params.name}: denied by the registry`);
        return text(`${name}: ${req.params.name} is denied by the registry (_deny)`) as never;
      }
      const t0 = Date.now();
      try {
        return await withBackend(slot, entry, idleMs, (r) =>
          r.client.callTool(req.params, undefined, {
            timeout: CALL_TIMEOUT_MS,
            resetTimeoutOnProgress: true,
            signal: extra.signal,
          })) as never;
      } catch (e) {
        log(`call ${slot.id} ${req.params.name} failed after ${Date.now() - t0}ms: ${(e as Error).message}`);
        return text(`${name}: ${(e as Error).message}`) as never;
      }
    });
    return server;
  }

  async function handle(req: Request, port: number): Promise<Response> {
    const url = new URL(req.url);
    // liveness: anyone may ask, and learns only that something of ours listens
    if (url.pathname === "/health") return json(200, { gateway: true });
    if (!localRequest(req.headers.get("host"), req.headers.get("origin"), port)) {
      return json(403, { error: "not a local request" });
    }
    const cfg = await current();
    const token = bearer(req.headers.get("authorization"));
    const authorize = async (profile: string | null) => {
      const check = () =>
        profile ? tokens.check(token, profile) : (token && tokens.profileOf(token) ? "ok" : "unauthorized");
      let access = check();
      if (access === "unauthorized" && Date.now() - tokensAt > 1000) {
        await loadTokens(); // a token rotated since the file was read
        access = check();
      }
      return access;
    };
    if (url.pathname === "/status") {
      if (await authorize(null) !== "ok") return json(401, { error: "unauthorized" });
      const up = [...slots.values()].filter((s) => s.running).map((s) => s.id).sort();
      return json(200, { gateway: true, pid: Deno.pid, code: opts.code ?? "", backends: up });
    }
    const target = parsePath(url.pathname);
    if (!target) return json(404, { error: "no such path" });
    const access = await authorize(target.profile);
    if (access === "unauthorized") return json(401, { error: "unauthorized" });
    if (access === "forbidden") return json(403, { error: "that token is for another profile" });
    const entry = cfg.profiles[target.profile]?.servers[target.server];
    if (!entry) return json(404, { error: "no such server for this profile" });
    if (req.method !== "POST") return json(405, { error: "stateless: POST only" });
    const server = await mcpFor(target.profile, target.server, entry, cfg.idleMs);
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  }

  // ── start ──────────────────────────────────────────────────────────────────────────────────────
  const cfg0 = await current();
  await reapOrphans();
  const stateFile = `${dir}/state.json`;
  let listening!: number;
  const srv = Deno.serve({
    hostname: "127.0.0.1",
    port: cfg0.port,
    onListen: (a) => {
      listening = a.port;
      log(`listening on 127.0.0.1:${a.port} pid=${Deno.pid}`);
    },
  }, (req) =>
    handle(req, listening).catch((e) => {
      log(`error: ${(e as Error).message}`);
      return json(500, { error: "gateway error" });
    }));
  await writeAtomic(
    stateFile,
    JSON.stringify({ pid: Deno.pid, code: opts.code ?? "", port: listening, at: new Date().toISOString() }),
  ).catch(() => {});

  let stopping: Promise<void> | null = null;
  const shutdown = () =>
    stopping ??= (async () => {
      log("stopping");
      const drained = srv.shutdown();
      await Promise.race([drained, new Promise((r) => setTimeout(r, drainMs))]);
      await Promise.all([...slots.values()].map((s) => stopSlot(s, "gateway stopping")));
      await Deno.remove(stateFile).catch(() => {});
    })();
  return { port: listening, shutdown, finished: srv.finished };
}
