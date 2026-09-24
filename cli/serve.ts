// serve.ts — the local console: `claude-multi serve` listens on http://127.0.0.1:7331.
//
// Page in cli/dashboard/ (HTML/CSS/JS, no dependencies, no build step: works offline). Data comes
// from status(), usage.ts and budget.ts.
//
// Live updates are pushed, not polled. The browser holds one EventSource on /api/events; the
// server watches the transcript tree and the runtime config and emits an event when something
// actually changed, so the panel you are looking at redraws itself. The old page polled /api/status
// every 30s and redrew four panels that were rarely the one on screen — which is why it looked
// frozen on Usage, Sessions and Budget.
//
// Actions (POST /api/action): an allowlist of CLI subcommands, localhost only, behind the
// `x-claude-multi` anti-CSRF header. Update is deliberately not among them: it goes through polkit.

import { ANSI, CACHE, profileNames, readJson, readText, REPO, RUNTIME } from "./lib.ts";
import { type RawRegistry, selectServers } from "./mcp.ts";
import { status } from "./status.ts";
import { type GroupBy, ingest, openDb, report, sessions, transcript } from "./usage.ts";
import { collect } from "./budget.ts";

export const PORT = Number(Deno.env.get("CLAUDE_MULTI_PORT") ?? 7331);
const DASH = `${REPO}/cli/dashboard`;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

/** Allowed actions to CLI arguments. `opts` accepted per action (anything else is ignored). */
const ACTIONS: Record<string, { args: string[]; opts?: Record<string, string[]>; timeoutMs?: number }> = {
  "doctor": { args: ["doctor"] },
  "sync-fetch": { args: ["sync", "--fetch"], timeoutMs: 30000 },
  "mcp-check": { args: ["mcp", "check"] },
  "mcp-sync": { args: ["mcp", "sync"], opts: { force: ["--force"] } },
  "install-dry": { args: ["install", "--dry-run"] },
  "install": { args: ["install"] },
  "usage-ingest": { args: ["usage", "ingest", "--full"], timeoutMs: 120000 },
  "update-check": { args: ["update", "--check"], timeoutMs: 40000 },
  "budget": { args: ["budget"] },
};

async function runAction(name: string, opts: string[]) {
  const a = ACTIONS[name];
  if (!a) return { code: 2, output: `unknown action: ${name}`, ms: 0 };
  const extra = (opts ?? []).flatMap((o) => a.opts?.[o] ?? []);
  const t0 = Date.now();
  const cmd = new Deno.Command(`${REPO}/bin/claude-multi`, { args: [...a.args, ...extra], cwd: REPO, stdout: "piped", stderr: "piped", env: { NO_COLOR: "1" } });
  const child = cmd.spawn();
  const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* already gone */ } }, a.timeoutMs ?? 60000);
  const r = await child.output(); clearTimeout(timer);
  const dec = new TextDecoder();
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  let output = strip(dec.decode(r.stdout)); const err = strip(dec.decode(r.stderr)).trim();
  if (err) output += (output ? "\n" : "") + err;
  // update --check exits 10 when an update exists: not an error (the check writes its own cache)
  if (name === "update-check") return { code: r.code === 10 ? 0 : r.code, output: output + (r.code === 10 ? "\n(updates available: use the gate, or claude-multi update)" : ""), ms: Date.now() - t0 };
  return { code: r.code, output, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- profiles
interface ProfileBody { name?: string; description?: string; command?: string; alias?: string; desktopDir?: string; cap?: number | null; mcp?: string[]; disableAccountMcp?: boolean }

/** Profile names become directory names and are interpolated into paths, so the shape is fixed
 *  here rather than sanitised later: lowercase, starts with a letter, no separators. */
const NAME_RE = /^[a-z][a-z0-9_-]{1,30}$/;

/**
 * Create or update a profile: write its manifest, point the MCP registry at it, record the alert
 * cap, then run `install` to materialise the runtime. Every write lands in the repository, which
 * is the source of truth — nothing here touches ~/.claude-multi directly.
 */
async function saveProfile(b: ProfileBody): Promise<{ error?: string; message?: string; output?: string }> {
  const name = String(b.name ?? "").trim();
  if (!NAME_RE.test(name)) return { error: "name must be lowercase, start with a letter, and use only letters, digits, - or _" };

  const dir = `${REPO}/profiles/${name}`;
  const manifestPath = `${dir}/profile.json`;
  const existing = await readJson<Record<string, unknown>>(manifestPath);
  const isNew = !existing;

  const manifest: Record<string, unknown> = {
    ...(existing ?? { skills: "all", agents: "all", commands: "all" }),
    description: b.description?.trim() || existing?.description || `Profile ${name}.`,
  };
  if (b.command?.trim()) manifest.command = b.command.trim(); else delete manifest.command;
  if (b.alias?.trim()) manifest.alias = b.alias.trim(); else delete manifest.alias;
  if (b.desktopDir?.trim()) manifest.desktopDir = b.desktopDir.trim(); else delete manifest.desktopDir;
  if (b.disableAccountMcp !== undefined) {
    if (b.disableAccountMcp) manifest.disableAccountMcp = true; else delete manifest.disableAccountMcp;
  }

  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (isNew && !(await readText(`${dir}/CLAUDE.md`))) {
    await Deno.writeTextFile(`${dir}/CLAUDE.md`, `# CLAUDE.md — ${name} profile\n\n${manifest.description}\n\n## Shared rules\n\n@${RUNTIME}/shared/rules/collaboration.md\n`);
  }

  if (Array.isArray(b.mcp)) await applyRegistrySelection(name, b.mcp);
  if (b.cap !== undefined) await applyCap(name, b.cap);

  const r = await runAction("install", []);
  // install reports its own diagnosis, so a non-zero exit is surfaced as output rather than
  // swallowed: the manifest is already written and the user needs to see what install said.
  return {
    message: `${isNew ? "Created" : "Updated"} profile ${name}${r.code ? " — install reported problems" : ""}`,
    output: r.output,
  };
}

/** Reflect a profile's server selection into shared/mcp/servers.json. An absent `_profiles` means
 *  "every profile", so opting one out has to materialise the list rather than just remove a name. */
async function applyRegistrySelection(name: string, picked: string[]) {
  const path = `${REPO}/shared/mcp/servers.json`;
  const reg = await readJson<RawRegistry>(path);
  if (!reg?.servers) return;
  const next = selectServers(reg, await profileNames(), name, picked);
  if (JSON.stringify(next) !== JSON.stringify(reg)) await Deno.writeTextFile(path, JSON.stringify(next, null, 2) + "\n");
}

/** Store the per-profile alert ceiling in shared/budget.json (null clears it). */
async function applyCap(name: string, cap: number | null) {
  const path = `${REPO}/shared/budget.json`;
  const cfg = await readJson<Record<string, unknown>>(path);
  if (!cfg) return;
  const before = JSON.stringify(cfg.profiles ?? {});
  const profiles = (cfg.profiles ?? {}) as Record<string, Record<string, unknown>>;
  const entry = profiles[name] ?? {};
  if (cap == null || !(cap > 0)) delete entry.cap; else entry.cap = cap;
  if (Object.keys(entry).length) profiles[name] = entry; else delete profiles[name];
  cfg.profiles = profiles;
  // unchanged → no write: the file is hand-formatted, and a rewrite would only reflow it
  if (JSON.stringify(profiles) !== before) await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2) + "\n");
}

// ---------------------------------------------------------------- live updates
type Topic = "usage" | "state";
/** A usage event carries which sessions wrote, so the page can light up the one that is working
 *  rather than repainting every row as busy. */
const clients = new Set<(topic: Topic, sessions?: string[]) => void>();

function broadcast(topic: Topic, sessions: string[] = []) {
  for (const send of clients) { try { send(topic, sessions); } catch { /* client gone, the reader removes it */ } }
}

/**
 * Watch what the console displays and say which half moved.
 * `usage`  new transcript lines — sessions, usage, budget estimates
 * `state`  runtime config, credentials, MCP registry — profiles, doctor, plan windows
 *
 * Events are coalesced: a busy session writes its transcript continuously, and one redraw per
 * second is plenty for a dashboard.
 */
async function watchTree(signal: AbortSignal) {
  let watcher: Deno.FsWatcher;
  try { watcher = Deno.watchFs([RUNTIME, `${REPO}/shared`], { recursive: true }); } catch { return; }
  signal.addEventListener("abort", () => { try { watcher.close(); } catch { /* already closed */ } });
  const pending = new Set<Topic>();
  const sessions = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const ids = [...sessions];
    for (const t of pending) broadcast(t, t === "usage" ? ids : []);
    pending.clear(); sessions.clear();
  };
  try {
    for await (const e of watcher) {
      if (e.kind === "access") continue;
      for (const p of e.paths) {
        if (p.endsWith(".tmp") || p.includes("/.git/")) continue;
        const transcript = p.includes("/projects/") && p.endsWith(".jsonl");
        pending.add(transcript ? "usage" : "state");
        // the file is named after the session, which is what the page needs to mark it as working
        if (transcript) {
          const id = p.slice(p.lastIndexOf("/") + 1, -6);
          if (/^[0-9a-f-]{36}$/.test(id)) sessions.add(id);
        }
      }
      if (pending.size && timer == null) timer = setTimeout(flush, 1000);
    }
  } catch { /* closed on shutdown */ }
}

function eventStream(): Response {
  let send: ((topic: Topic, sessions?: string[]) => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const close = () => {
    if (ping != null) { clearInterval(ping); ping = null; }
    if (send) { clients.delete(send); send = null; }
  };
  const body = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const write = (s: string) => {
        try { controller.enqueue(enc.encode(s)); } catch { close(); }
      };
      write("retry: 2000\n\n");
      send = (topic, ids = []) => write(`event: ${topic}\ndata: ${JSON.stringify({ at: Date.now(), sessions: ids })}\n\n`);
      clients.add(send);
      // A proxy or a sleeping laptop can drop a silent connection: a comment every 25s keeps it
      // alive and gives the page a heartbeat to time its "last update" indicator against.
      ping = setInterval(() => write(`: ping ${Date.now()}\n\n`), 25000);
    },
    cancel: close,
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "connection": "keep-alive" },
  });
}

// ---------------------------------------------------------------- server
export async function serve(opts: { open?: boolean } = { open: true }) {
  const url = `http://127.0.0.1:${PORT}`;
  let cache: { at: number; body: string } | null = null;
  let budget: { at: number; body: string } | null = null;
  const ac = new AbortController();
  const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  // a state change invalidates the cached snapshots, so the next request after an event is fresh
  clients.add((topic) => { if (topic === "state") cache = null; budget = null; });

  const handler = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/api/events") return eventStream();

      if (u.pathname === "/api/status") {
        if (!cache || u.searchParams.has("fresh") || Date.now() - cache.at > 5000) cache = { at: Date.now(), body: JSON.stringify(await status()) };
        return new Response(cache.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (u.pathname === "/api/usage") {
        const db = openDb(); await ingest(db, { quiet: true });
        const r = report(db, {
          by: (u.searchParams.get("by") ?? "profile") as GroupBy, since: u.searchParams.get("since") ?? "30d",
          profile: u.searchParams.get("profile") || undefined, limit: Number(u.searchParams.get("limit") ?? 60),
          split: (u.searchParams.get("split") || undefined) as GroupBy | undefined,
        });
        db.close();
        return json(r);
      }
      if (u.pathname === "/api/sessions") {
        const db = openDb(); await ingest(db, { quiet: true });
        const r = sessions(db, { since: u.searchParams.get("since") ?? "7d", profile: u.searchParams.get("profile") || undefined, limit: Number(u.searchParams.get("limit") ?? 60) });
        db.close();
        return json(r);
      }
      if (u.pathname === "/api/transcript") {
        const id = u.searchParams.get("session");
        if (!id) return json({ error: "session parameter required" }, 400);
        const db = openDb();
        const r = await transcript(db, id, Number(u.searchParams.get("limit") ?? 200));
        db.close();
        return json(r);
      }
      if (u.pathname === "/api/budget") {
        if (!budget || u.searchParams.has("fresh") || Date.now() - budget.at > 30000) budget = { at: Date.now(), body: JSON.stringify(await collect({ ingest: false })) };
        return new Response(budget.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (u.pathname === "/api/sync") return new Response(await readText(`${CACHE}/sync.json`) ?? "null", { headers: { "content-type": "application/json" } });
      if (u.pathname === "/api/profile") {
        if (req.method !== "POST") return json({ error: "POST required" }, 405);
        if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
        const r = await saveProfile(await req.json().catch(() => ({})));
        cache = null; budget = null;
        broadcast("state");
        return json(r, r.error ? 400 : 200);
      }
      if (u.pathname === "/api/action") {
        if (req.method !== "POST") return json({ error: "POST required" }, 405);
        if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
        const body = await req.json().catch(() => ({})) as { action?: string; opts?: string[] };
        const r = await runAction(String(body.action ?? ""), body.opts ?? []);
        cache = null; budget = null;
        broadcast("state");
        return json(r);
      }
      // static
      const path = u.pathname === "/" ? "/index.html" : u.pathname;
      if (!/^\/[a-z0-9_.-]+$/i.test(path)) return new Response("not found", { status: 404 });
      const ext = path.slice(path.lastIndexOf("."));
      const body = await readText(`${DASH}${path}`);
      if (body === null || !MIME[ext]) return new Response("not found", { status: 404 });
      return new Response(body, { headers: { "content-type": MIME[ext], "cache-control": "no-cache" } });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  };

  console.log(`${ANSI.b}claude-multi serve${ANSI.x} — ${url}  ${ANSI.d}(Ctrl-C to stop; localhost only)${ANSI.x}`);
  void watchTree(ac.signal);
  const srv = Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => {}, signal: ac.signal }, handler);
  if (opts.open) { try { new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn().unref(); } catch { /* no browser */ } }
  await srv.finished;
}
