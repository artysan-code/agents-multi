// serve.ts — the local console: `claude-multi serve` listens on http://127.0.0.1:7331.
//
// Page in cli/dashboard/ (HTML/CSS/JS, no dependencies, no build step: works offline). Data comes
// from status(), the tasks (taskboard.ts), the brain (memory.ts), the old wiki (brain.ts), the vault and accounts, and the
// session index of usage.ts (Today's "pick up again").
//
// Live updates are pushed, not polled. The browser holds one EventSource on /api/events; the
// server watches the transcript tree, the runtime config, the wiki and the tasks, and emits an
// event when something actually changed, so the panel you are looking at redraws itself.
//
// Actions (POST /api/action): an allowlist of CLI subcommands, localhost only, behind the
// `x-claude-multi` anti-CSRF header. Updating needs no privilege any more (Claude Desktop lives in
// user space), so it is an action like the others.

import { ANSI, CONFIG, HOME, listDir, lstat, PROFILES, profileNames, readJson, readText, REPO, RUNTIME, STATE } from "./lib.ts";
import { ACCOUNTS, loadRegistry, missingPrograms, rawRegistry, selectServers, writePersonRegistry } from "./mcp.ts";
import { type Account, loadAccounts } from "../shared/mcp/lib/accounts.ts";
import { deleteSecret, getSecret, keyMatches, listSecrets, loadKey, setSecret, vaultDir } from "../shared/mcp/lib/vault.ts";
import { startConnect, storeClient } from "./google.ts";
import { startBrainLogin } from "./brain-login.ts";
import { codeVersion } from "./codeversion.ts";
import { calendarAsTasks } from "./agenda.ts";
import { taskApi } from "./taskboard.ts";
import { askApi } from "./ask.ts";
import { assetsApi, claudeAssets } from "./claude-assets.ts";
import { probeAccount } from "./vault.ts";
import { brainGraph, brainPage } from "./brain.ts";
import { memoryApi, memoryVersion } from "./memory.ts";
import { owner } from "../shared/mcp/lib/owner.ts";
import { type PermOp, permissionsOp, permissionsView } from "./permissions.ts";
import { addTask, brief, listTasks, tasksRoot, type TaskInput, updateTask } from "../shared/mcp/lib/tasks.ts";
import { connectTasks } from "../shared/mcp/lib/brain-tasks.ts";
import { status, summarize } from "./status.ts";
import { ingest, openDb, sessions } from "./usage.ts";
import { catalog, details, inventory, pluginOp, type PluginOp } from "./plugins.ts";

export const PORT = Number(Deno.env.get("CLAUDE_MULTI_PORT") ?? 7331);
/** The code this console started with (codeversion.ts): set by serve(), told to every page. */
let CODE = "";
const DASH = `${REPO}/cli/dashboard`;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8" };

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
  "update-now": { args: ["update", "--auto"], timeoutMs: 900000 },
  "rollback-cli": { args: ["update", "--rollback"] },
  "rollback-desktop": { args: ["update", "--rollback", "--desktop"], timeoutMs: 180000 },
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
  // deno-lint-ignore no-control-regex
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  let output = strip(dec.decode(r.stdout)); const err = strip(dec.decode(r.stderr)).trim();
  if (err) output += (output ? "\n" : "") + err;
  // update --check exits 10 when an update exists: not an error (the check writes its own cache)
  if (name === "update-check") return { code: r.code === 10 ? 0 : r.code, output, ms: Date.now() - t0 };
  return { code: r.code, output, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- profiles
interface ProfileBody { name?: string; description?: string; command?: string; alias?: string; desktopDir?: string; mcp?: string[]; disableAccountMcp?: boolean }

/** Profile names become directory names and are interpolated into paths, so the shape is fixed
 *  here rather than sanitised later: lowercase, starts with a letter, no separators. */
const NAME_RE = /^[a-z][a-z0-9_-]{1,30}$/;

/**
 * Create or update a profile: write its manifest, point the MCP registry at it, then run
 * `install` to materialise the runtime. Every write lands in the repository, which
 * is the source of truth — nothing here touches ~/.claude-multi directly.
 */
async function saveProfile(b: ProfileBody): Promise<{ error?: string; message?: string; output?: string }> {
  const name = String(b.name ?? "").trim();
  if (!NAME_RE.test(name)) return { error: "name must be lowercase, start with a letter, and use only letters, digits, - or _" };

  const dir = `${PROFILES}/${name}`;
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
    // the person's rules, all of them, as the other profiles import them
    const rules = (await listDir(`${CONFIG}/rules`)).filter((f) => f.endsWith(".md")).map((f) => `@~/.claude-multi/config/rules/${f}`).join("\n");
    await Deno.writeTextFile(`${dir}/CLAUDE.md`, `# CLAUDE.md — ${name} profile\n\n${manifest.description}\n${rules ? `\n## Rules\n\n${rules}\n` : ""}`);
  }

  if (Array.isArray(b.mcp)) await applyRegistrySelection(name, b.mcp);

  const r = await runAction("install", []);
  // install reports its own diagnosis, so a non-zero exit is surfaced as output rather than
  // swallowed: the manifest is already written and the user needs to see what install said.
  return {
    message: `${isNew ? "Created" : "Updated"} profile ${name}${r.code ? " — install reported problems" : ""}`,
    output: r.output,
  };
}

/** Reflect a profile's server selection into the person's servers.json. An absent `_profiles` means
 *  "every profile", so opting one out has to materialise the list rather than just remove a name. */
async function applyRegistrySelection(name: string, picked: string[]) {
  const reg = await rawRegistry().catch(() => null);
  if (!reg?.servers) return;
  const next = selectServers(reg, await profileNames(), name, picked);
  if (JSON.stringify(next) !== JSON.stringify(reg)) await writePersonRegistry(next);
}

// ---------------------------------------------------------------- accounts
/** What Connections shows: the accounts, whether this machine has each one's secret, and the vault's
 *  state. Never a secret value. */
async function accountsView() {
  const reg = await loadRegistry();
  const services = [...new Set(Object.values(reg.servers).map((c) => c._service).filter((x): x is string => !!x))].sort();
  const accounts = loadAccounts(ACCOUNTS);
  let state = "ok", detail = "", conflicts = 0, unreadable = 0;
  let have = new Set<string>();
  try {
    const key = await loadKey();
    if (!(await keyMatches(key))) { state = "wrong-key"; }
    else {
      const l = await listSecrets(key);
      have = new Set(l.entries.map((e) => `${e.service}/${e.account}`));
      conflicts = l.conflicts; unreadable = l.unreadable;
    }
  } catch (e) { state = "no-key"; detail = (e as Error).message; }
  const initialised = !!(await readText(`${vaultDir()}/key-check.json`));
  const googleClient = state === "ok" && !!(await getSecret("google-oauth", "client", "id").catch(() => null));
  const missing = new Map<string, Awaited<ReturnType<typeof missingPrograms>>>();
  for (const s of new Set(accounts.map((a) => a.service))) missing.set(s, await missingPrograms(s, reg));
  return {
    google: { client: googleClient, last: lastConnect },
    vault: { dir: vaultDir(), state, detail, initialised, conflicts, unreadable },
    services,
    profiles: await profileNames(),
    accounts: accounts.map((a) => ({ ...a, hasSecret: have.has(`${a.service}/${a.name}`), missing: missing.get(a.service) ?? [] })),
  };
}

const ACCOUNT_NAME = /^[a-z][a-z0-9_-]{0,30}$/;
/** How the last Google connection or brain sign-in ended: the page shows it when the browser comes back. */
let lastConnect: { account: string; ok: boolean; message: string; at: string } | null = null;

/** Add or change an account (and its secret), or remove one. The secret, when given, is checked
 *  against the service first: a wrong one is refused rather than stored. */
async function accountOp(b: { op?: string; service?: string; name?: string; url?: string; profiles?: string[] | null; secret?: string }) {
  const service = String(b.service ?? ""), name = String(b.name ?? "").trim();
  if (!service || !ACCOUNT_NAME.test(name)) return { ok: false, message: "the name is lowercase letters, digits, - or _, starting with a letter" };
  const raw = await readJson<{ accounts: Account[] } & Record<string, unknown>>(ACCOUNTS) ?? { accounts: [] };
  const i = raw.accounts.findIndex((a) => a.service === service && a.name === name);
  if (b.op === "delete") {
    if (i >= 0) raw.accounts.splice(i, 1);
    await Deno.writeTextFile(ACCOUNTS, JSON.stringify(raw, null, 2) + "\n");
    const gone = await deleteSecret(service, name).catch(() => false);
    return { ok: true, message: `${service}/${name} removed${gone ? " with its secret" : ""}` };
  }
  let url: string | undefined;
  if (b.url?.trim()) {
    try { url = new URL(b.url.trim()).origin; } catch { return { ok: false, message: "the address is not a valid URL" }; }
  }
  const account: Account = { service, name, ...(url ? { url } : {}), ...(b.profiles?.length ? { profiles: [...b.profiles].sort() } : {}) };
  if (b.secret) {
    const probe = await probeAccount(account, b.secret);
    if (!probe.ok) return { ok: false, message: `the secret does not open ${service}/${name} (${probe.detail}): not stored` };
    await setSecret(service, name, b.secret);
  }
  if (i >= 0) raw.accounts[i] = { ...raw.accounts[i], ...account, ...(b.profiles?.length ? {} : { profiles: undefined }) };
  else raw.accounts.push(account);
  raw.accounts = raw.accounts.map((a) => JSON.parse(JSON.stringify(a))); // drop undefined keys
  await Deno.writeTextFile(ACCOUNTS, JSON.stringify(raw, null, 2) + "\n");
  // saved either way (the program can be installed afterwards), but said now: its server will not start until then
  const missing = await missingPrograms(service);
  const warn = missing.map((m) => `the ${m.server} server will not start: ${m.problem}${m.install ? ` — install it with: ${m.install}` : ""}`).join("; ");
  return { ok: true, message: `${service}/${name} saved${b.secret ? ", secret checked and stored" : ""}${warn ? `. But ${warn}` : ""}`, ...(missing.length ? { missing } : {}) };
}

// ---------------------------------------------------------------- live updates
type Topic = "usage" | "state" | "brain" | "tasks";
/** A usage event carries which sessions wrote, so the page can light up the one that is working
 *  rather than repainting every row as busy. */
const clients = new Set<(topic: Topic, sessions?: string[]) => void>();

function broadcast(topic: Topic, sessions: string[] = []) {
  for (const send of clients) { try { send(topic, sessions); } catch { /* client gone, the reader removes it */ } }
}

/**
 * Watch what the console displays and say which half moved.
 * `usage`  new transcript lines — running and recent sessions
 * `state`  runtime config, credentials, MCP registry — profiles, doctor, plan windows
 * `brain`  a page of the brain changed (anywhere: watchBrain asks it every half minute)
 * `tasks`  a task changed: a chat, another machine, the console
 *
 * Events are coalesced: a busy session writes its transcript continuously, and one redraw per
 * second is plenty for a dashboard.
 */
async function watchTree(signal: AbortSignal) {
  // The update check's cache, and the state directory where every update result is logged
  // (updates.jsonl): the Updates tab follows both. watchFs refuses a path that does not exist, so
  // those two are watched only where they are.
  const paths = [RUNTIME, `${REPO}/shared`];
  // the vault too: Syncthing bringing a secret from another machine changes what Connections shows
  for (const d of [`${HOME}/.cache/claude-update`, STATE, vaultDir(), tasksRoot()]) if (await lstat(d)) paths.push(d);
  let watcher: Deno.FsWatcher;
  try { watcher = Deno.watchFs(paths, { recursive: true }); } catch { return; }
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
        if (p.endsWith(".tmp") || p.includes("/.git/") || p.includes("/.obsidian/")) continue;
        if (p.startsWith(`${tasksRoot()}/`)) { pending.add("tasks"); continue; }
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
      // first, which code is serving: a page loaded from an older console reloads itself
      write(`event: hello\ndata: ${JSON.stringify({ code: CODE })}\n\n`);
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
/** The brain changes elsewhere (the phone, a chat on another machine) and touches no file here:
 *  every half minute its tasks and its memory version are read, and a `tasks` or `brain` event goes
 *  out when one differs. The console's own task writes broadcast at once, through taskApi. */
async function watchBrain(signal: AbortSignal, tasks: boolean) {
  let lastTasks = "", lastMemory: string | null = null;
  while (!signal.aborted) {
    if (tasks) {
      try {
        const now = JSON.stringify((await listTasks()).map((t) => [t.id, t.updated]).sort());
        if (lastTasks && now !== lastTasks) broadcast("tasks");
        lastTasks = now;
      } catch { /* the brain is away: the panels say so when they ask */ }
    }
    const memory = await memoryVersion().catch(() => null);
    if (memory && lastMemory && memory !== lastMemory) broadcast("brain");
    if (memory) lastMemory = memory;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

export async function serve(opts: { open?: boolean } = { open: true }) {
  const url = `http://127.0.0.1:${PORT}`;
  CODE = await codeVersion();
  // The status report takes a second or more (it runs the doctor). Pages must not wait for it on
  // every open: it is computed at start, kept, and refreshed behind the scenes when it ages; a
  // request waits only when something changed (a state event, an action) and the old report would
  // be wrong. Concurrent requests share one computation.
  let cache: { at: number; gen: number; body: string; report: Awaited<ReturnType<typeof status>> } | null = null;
  // `gen` counts changes: a report computed before the last one is not served where freshness matters
  let gen = 0, inflight: Promise<void> | null = null;
  const refreshStatus = () => inflight ??= (async () => {
    const g = gen;
    try {
      const report = await status();
      cache = { at: Date.now(), gen: g, body: JSON.stringify(report), report };
    } finally { inflight = null; }
  })();
  const invalidate = () => { gen++; };
  const statusCache = async (fresh: boolean) => {
    if (fresh) invalidate();
    while (!cache || cache.gen !== gen) await refreshStatus();
    if (Date.now() - cache.at > 5000) void refreshStatus().catch(() => {});
  };
  let plugins: { at: number; body: string } | null = null;
  const ac = new AbortController();
  const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  // a state change invalidates the cached snapshots, so the next request after an event is fresh
  // lazily: state events can be frequent while sessions run, and only a page asking needs the report
  clients.add((topic) => { if (topic === "state") invalidate(); });
  void refreshStatus().catch(() => {}); // warm: the first page after a start is not the one to wait
  void claudeAssets(); // the scan of Desktop's bundle, done before the first page asks for it

  const handler = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    // DNS rebinding: a web page whose name resolves to 127.0.0.1 would be same-origin with the
    // console, and the anti-CSRF header would not stop it. Only local names are served (any port,
    // so an ssh tunnel on another local port still works).
    const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
    if (!["127.0.0.1", "localhost", "[::1]"].includes(host)) return new Response("forbidden host", { status: 403 });
    try {
      if (u.pathname === "/api/events") return eventStream();
      if (u.pathname === "/api/code") return json({ code: CODE });

      if (u.pathname === "/api/status") {
        await statusCache(u.searchParams.has("fresh"));
        return new Response(cache!.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      // the tray's view of the same report: one level and the lines behind it
      if (u.pathname === "/api/summary") {
        await statusCache(u.searchParams.has("fresh"));
        return json(summarize(cache!.report));
      }
      if (u.pathname === "/api/sessions") {
        const db = openDb(); await ingest(db, { quiet: true });
        const r = sessions(db, { since: u.searchParams.get("since") ?? "7d", profile: u.searchParams.get("profile") || undefined, limit: Number(u.searchParams.get("limit") ?? 60) });
        db.close();
        return json(r);
      }
      if (u.pathname === "/api/brain/login") {
        if (req.method !== "POST") return json({ error: "POST required" }, 405);
        if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
        try {
          const { account } = await req.json() as { account: string };
          const url = await startBrainLogin(String(account), (r) => {
            lastConnect = { account, ...r, at: new Date().toISOString() };
            invalidate();
            broadcast("state");
          });
          return json({ ok: true, url });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      }
      if (u.pathname === "/api/google/client" || u.pathname === "/api/google/connect") {
        if (req.method !== "POST") return json({ error: "POST required" }, 405);
        if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
        try {
          if (u.pathname === "/api/google/client") {
            const prefix = await storeClient(await req.text());
            broadcast("state");
            return json({ ok: true, message: `OAuth client ${prefix}… stored` });
          }
          const { account } = await req.json() as { account: string };
          const url = await startConnect(String(account), (r) => {
            lastConnect = { account, ...r, at: new Date().toISOString() };
            broadcast("state");
          });
          return json({ ok: true, url });
        } catch (e) {
          return json({ ok: false, message: (e as Error).message });
        }
      }
      if (u.pathname === "/api/accounts") {
        if (req.method === "POST") {
          if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
          const r = await accountOp(await req.json().catch(() => ({})));
          invalidate();
          broadcast("state");
          return json(r);
        }
        return json(await accountsView());
      }
      if (u.pathname === "/api/permissions") {
        if (req.method === "POST") {
          if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
          const r = await permissionsOp(await req.json().catch(() => ({})) as PermOp);
          broadcast("state");
          return json(r);
        }
        return json(await permissionsView());
      }
      const ca = await assetsApi(u);
      if (ca) return ca;
      const ar = await askApi(req, u, json);
      if (ar) return ar;
      const tr = await taskApi(req, u, json, () => broadcast("tasks"));
      if (tr) return tr;
      if (u.pathname === "/api/tasks") {
        if (req.method === "POST") {
          if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
          const b = await req.json().catch(() => ({})) as TaskInput & { op?: string; id?: string };
          try {
            const { op, id, ...input } = b;
            const r = op === "add" ? { task: await addTask(input) } : await updateTask(String(id ?? ""), input);
            broadcast("tasks");
            return json({ ok: true, task: r.task });
          } catch (e) {
            return json({ ok: false, message: (e as Error).message });
          }
        }
        const cal = await calendarAsTasks(), now = new Date();
        const b = brief([...await listTasks(), ...cal.tasks], now);
        // today's appointments already past: the day on the page keeps them above the line for now
        const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        const earlier = cal.tasks.filter((t) => t.due === b.day && t.time && t.time < clock);
        return json({ ...b, earlier, calendarErrors: cal.errors });
      }
      if (u.pathname === "/api/owner") return json(owner()); // whose console this is: the tasks page needs the id
      const mr = req.method === "GET" ? await memoryApi(u) : null;
      if (mr) return mr;
      // the old wiki, read-only: the Brain page's Archive
      if (u.pathname === "/api/archive") return json(await brainGraph());
      if (u.pathname === "/api/archive/page") return json(await brainPage(u.searchParams.get("path") ?? ""));
      if (u.pathname === "/api/profile") {
        if (req.method !== "POST") return json({ error: "POST required" }, 405);
        if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
        const r = await saveProfile(await req.json().catch(() => ({})));
        invalidate();
        broadcast("state");
        return json(r, r.error ? 400 : 200);
      }
      // plugins: GET the table / the catalog / one plugin's details, POST an operation
      if (u.pathname === "/api/plugins") {
        if (req.method === "POST") {
          if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
          const r = await pluginOp(await req.json().catch(() => ({})) as PluginOp);
          plugins = null; invalidate();
          broadcast("state");
          return json(r); // a refused operation is a result (ok: false, message), not an HTTP error
        }
        if (!plugins || u.searchParams.has("fresh") || Date.now() - plugins.at > 15000) plugins = { at: Date.now(), body: JSON.stringify(await inventory()) };
        return new Response(plugins.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (u.pathname === "/api/plugins/catalog") return json(await catalog(u.searchParams.has("fresh")));
      if (u.pathname === "/api/plugins/details") return json({ text: await details(u.searchParams.get("id") ?? "") });
      if (u.pathname === "/api/action") {
        if (req.method !== "POST") return json({ error: "POST required" }, 405);
        if (req.headers.get("x-claude-multi") !== "1") return json({ error: "missing header" }, 403);
        const body = await req.json().catch(() => ({})) as { action?: string; opts?: string[] };
        const r = await runAction(String(body.action ?? ""), body.opts ?? []);
        invalidate();
        broadcast("state");
        return json(r);
      }
      // static: the faces are bytes and never change under a name, the rest is text
      const font = u.pathname.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
      if (font) {
        const bytes = await Deno.readFile(`${DASH}/fonts/${font[1]}`).catch(() => null);
        if (!bytes) return new Response("not found", { status: 404 });
        return new Response(bytes, { headers: { "content-type": "font/woff2", "cache-control": "max-age=31536000, immutable" } });
      }
      const path = u.pathname === "/" ? "/index.html" : u.pathname;
      // the page's files, and the libraries it carries in vendor/ (no CDN: the console works offline)
      if (!/^\/(vendor\/)?[a-z0-9_.-]+$/i.test(path)) return new Response("not found", { status: 404 });
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
  void watchBrain(ac.signal, connectTasks() === "brain");
  const srv = Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => {}, signal: ac.signal }, handler);
  if (opts.open) { try { new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn().unref(); } catch { /* no browser */ } }
  await srv.finished;
}
