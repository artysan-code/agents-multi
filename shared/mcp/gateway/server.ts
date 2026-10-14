#!/usr/bin/env -S deno run
// gateway — the lazy MCP gateway (docs/adr/0008): one process per machine on 127.0.0.1, one Streamable
// HTTP endpoint per (profile, server). A session lists a server's tools from a cache, so nothing is
// started when it opens; the stdio server behind the path starts on the first call, is shared by every
// session of that profile, and stops when it has been idle for a while.
//
//   gateway/server.ts <backends.json>
//
// Stateless on purpose: no session ids, one MCP server object per request. A gateway that restarts loses
// nothing, and the client's next request is simply answered (it reconnects by itself).
import { Server } from "npm:@modelcontextprotocol/sdk@1.32.1/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "npm:@modelcontextprotocol/sdk@1.32.1/types.js";
import {
  Activity,
  bearer,
  type CachedList,
  cacheFile,
  type GatewayConfig,
  idleCheckIn,
  idleDue,
  localRequest,
  parsePath,
  sameBackend,
  type ServerEntry,
  TokenMap,
  usableCache,
} from "./core.ts";
import { CALL_TIMEOUT_MS, describe, type Running, startBackend } from "./backend.ts";

const configPath = Deno.args[0];
if (!configPath) {
  console.error("usage: gateway/server.ts <backends.json>");
  Deno.exit(2);
}
const cacheDir = `${configPath.replace(/\/[^/]*$/, "")}/cache`;
const code = Deno.env.get("AGENTS_MULTI_GATEWAY_CODE") ?? "";
const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const text = (t: string, isError = false) => ({
  content: [{ type: "text", text: t }],
  ...(isError ? { isError } : {}),
});

// ── configuration: read again when the file changes ────────────────────────────────────────────────
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

// ── backends ──────────────────────────────────────────────────────────────────────────────────────
interface Slot {
  name: string;
  key: string;
  running: Running | null;
  starting: Promise<Running> | null;
  act: Activity;
  timer: ReturnType<typeof setTimeout> | null;
}
const slots = new Map<string, Slot>();

function stop(slot: Slot, why: string) {
  const r = slot.running;
  slot.running = null;
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  if (r) {
    log(`stop ${slot.name} pid=${r.pid} (${why})`);
    void r.close();
  }
}

function watchIdle(slot: Slot, idleMs: number) {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = setTimeout(() => {
    slot.timer = null;
    if (!slot.running) return;
    if (idleDue(slot.act, Date.now(), idleMs)) stop(slot, `idle ${Math.round(idleMs / 1000)}s`);
    else watchIdle(slot, idleMs);
  }, idleCheckIn(slot.act, Date.now(), idleMs));
}

function slotFor(profile: string, name: string, entry: ServerEntry): Slot {
  const id = `${profile}/${name}`;
  let slot = slots.get(id);
  if (slot && !sameBackend(slot, entry)) {
    stop(slot, "its entry changed");
    slot = undefined;
  }
  if (!slot) {
    slot = {
      name: id,
      key: entry.key,
      running: null,
      starting: null,
      act: { inflight: 0, lastUsed: Date.now() },
      timer: null,
    };
    slots.set(id, slot);
  }
  return slot;
}

/** The running backend of a slot, started if need be (concurrent first calls share one start). */
function ensure(slot: Slot, entry: ServerEntry, idleMs: number): Promise<Running> {
  if (slot.running) return Promise.resolve(slot.running);
  return slot.starting ??= (async () => {
    const t0 = Date.now();
    try {
      const r = await startBackend(entry, Deno.env.toObject());
      slot.running = r;
      log(`start ${slot.name} pid=${r.pid} in ${Date.now() - t0}ms`);
      void r.gone.then(() => {
        if (slot.running === r) {
          slot.running = null;
          if (slot.timer) clearTimeout(slot.timer);
          slot.timer = null;
          log(`gone ${slot.name} pid=${r.pid}`);
        }
      });
      watchIdle(slot, idleMs);
      return r;
    } finally {
      slot.starting = null;
    }
  })();
}

/** Runs `fn` on the slot's backend, counting it as work (the idle clock waits for it). */
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
    if (slot.running) watchIdle(slot, idleMs);
  }
}

async function writeCache(name: string, entry: ServerEntry, list: { tools: unknown[]; instructions?: string }) {
  const body: CachedList = { key: entry.key, at: new Date().toISOString(), ...list };
  await Deno.mkdir(cacheDir, { recursive: true });
  const file = cacheFile(cacheDir, name, entry.key);
  await Deno.writeTextFile(`${file}.tmp`, JSON.stringify(body));
  await Deno.rename(`${file}.tmp`, file);
}
const readCache = async (name: string, entry: ServerEntry) =>
  usableCache(JSON.parse(await Deno.readTextFile(cacheFile(cacheDir, name, entry.key)).catch(() => "null")), entry.key);

// ── MCP ───────────────────────────────────────────────────────────────────────────────────────────
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
    if (hit) return { tools: hit.tools as never };
    // the cache is built by the first real start; this session is the one that pays for it
    try {
      const list = await withBackend(slot, entry, idleMs, (r) => describe(r.client));
      await writeCache(name, entry, list);
      log(`cache ${name} (${list.tools.length} tools)`);
      return { tools: list.tools as never };
    } catch (e) {
      log(`list ${slot.name} failed: ${(e as Error).message}`);
      return { tools: [] };
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (req: CallReq, extra: { signal: AbortSignal }) => {
    const t0 = Date.now();
    try {
      return await withBackend(slot, entry, idleMs, (r) =>
        r.client.callTool(req.params, undefined, {
          timeout: CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          signal: extra.signal,
        })) as never;
    } catch (e) {
      log(`call ${slot.name} ${req.params.name} failed after ${Date.now() - t0}ms: ${(e as Error).message}`);
      return text(`${name}: ${(e as Error).message}`, true) as never;
    }
  });
  return server;
}

interface CallReq {
  params: { name: string; arguments?: Record<string, unknown> };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function handle(req: Request, port: number): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/health") {
    return json(200, {
      gateway: true,
      pid: Deno.pid,
      code,
      backends: [...slots.values()].filter((s) => s.running).length,
    });
  }
  if (!localRequest(req.headers.get("host"), req.headers.get("origin"), port)) {
    return json(403, { error: "not a local request" });
  }
  const target = parsePath(url.pathname);
  if (!target) return json(404, { error: "no such path" });
  const cfg = await current();
  let access = tokens.check(bearer(req.headers.get("authorization")), target.profile);
  if (access === "unauthorized" && Date.now() - tokensAt > 1000) {
    await loadTokens(); // a token rotated since the file was read
    access = tokens.check(bearer(req.headers.get("authorization")), target.profile);
  }
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

const cfg0 = await current();
try {
  const srv = Deno.serve({
    hostname: "127.0.0.1",
    port: cfg0.port,
    onListen: () => log(`listening on 127.0.0.1:${cfg0.port} pid=${Deno.pid}`),
  }, (req) =>
    handle(req, cfg0.port).catch((e) => {
      log(`error: ${(e as Error).message}`);
      return json(500, { error: "gateway error" });
    }));
  const down = async () => {
    log("stopping");
    await Promise.all([...slots.values()].map((s) => s.running?.close()));
    await srv.shutdown();
    Deno.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) Deno.addSignalListener(sig, () => void down());
  await srv.finished;
} catch (e) {
  if (e instanceof Deno.errors.AddrInUse) {
    log(`port ${cfg0.port} is taken: a gateway is already running`);
    Deno.exit(0);
  }
  throw e;
}
