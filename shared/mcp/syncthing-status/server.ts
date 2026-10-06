#!/usr/bin/env -S deno run --allow-net=127.0.0.1:8384 --allow-read --allow-env --allow-run=git
// syncthing-status — read-only MCP server for the status of the local Syncthing instance.
// Talks only to Syncthing's REST API on localhost (ST_URL, default http://127.0.0.1:8384).
// The API key is read at runtime from Syncthing's config.xml (or the STGUI_APIKEY env variable)
// and is never persisted anywhere else.
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/stdio.js";
import { type Compiled, compilePattern, isIgnored } from "./ignore.ts";

/** Subset of Syncthing's REST objects that this server reads. */
interface StFolder {
  id: string;
  label?: string;
  path: string;
  type: string;
  paused?: boolean;
}
interface StConfig {
  folders?: StFolder[];
  devices?: unknown[];
}
interface StDbStatus {
  state?: string;
  needFiles?: number;
  needDeletes?: number;
  pullErrors?: number;
  errors?: number;
  globalFiles?: number;
}
interface StConnections {
  connections?: Record<string, { connected?: boolean }>;
}
interface StErrors {
  errors?: ({ message?: string } | string)[];
}
interface GitReportRow {
  folder: string;
  repo: string;
  gitDirSynced: boolean;
  trackedExposed: number;
  trackedTotal: number;
  note?: string;
  risk: string;
}

const BASE = Deno.env.get("ST_URL") ?? "http://127.0.0.1:8384";
const HOME = Deno.env.get("HOME") ?? "";

/** Path of Syncthing's config.xml: ST_CONFIG, else the first existing default location. */
function configPath(): string {
  const env = Deno.env.get("ST_CONFIG");
  if (env) return env;
  for (const p of [`${HOME}/.local/state/syncthing/config.xml`, `${HOME}/.config/syncthing/config.xml`]) {
    try {
      Deno.statSync(p);
      return p;
    } catch { /* next */ }
  }
  return `${HOME}/.local/state/syncthing/config.xml`;
}

/** Syncthing API key from STGUI_APIKEY or config.xml. Throws when neither provides one. */
function apiKey(): string {
  const env = Deno.env.get("STGUI_APIKEY");
  if (env) return env;
  const xml = Deno.readTextFileSync(configPath());
  const m = xml.match(/<apikey>([^<]+)<\/apikey>/);
  if (!m) throw new Error("Syncthing API key not found (config.xml or STGUI_APIKEY env variable).");
  return m[1].trim();
}

const KEY = apiKey();

/** GET `path` on the Syncthing REST API and return the parsed JSON, typed by the caller. Throws on a non-2xx status. */
async function st<T = unknown>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { headers: { "X-API-Key": KEY } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return await r.json() as T;
}
const txt = (o: unknown) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});

async function* walk(
  root: string,
  pick: (e: Deno.DirEntry) => boolean,
  prune: (n: string) => boolean,
  max = 8,
  d = 0,
): AsyncGenerator<string> {
  if (d > max) return;
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(root)];
  } catch {
    return;
  }
  for (const e of entries) {
    const p = `${root}/${e.name}`;
    if (pick(e)) yield p;
    else if (e.isDirectory && !prune(e.name)) yield* walk(p, pick, prune, max, d + 1);
  }
}

const server = new McpServer({ name: "syncthing-status", version: "0.1.0" });

server.registerTool("syncthing_status", {
  description:
    "Overall status of the local Syncthing: version, OS, uptime, number of folders and devices, active connections, system errors.",
  inputSchema: {},
}, async () => {
  const [ver, sys, cfg, conns, errs] = await Promise.all([
    st<{ version?: string; os?: string; arch?: string }>("/rest/system/version"),
    st<{ myID?: string; uptime?: number }>("/rest/system/status"),
    st<StConfig>("/rest/config"),
    st<StConnections>("/rest/system/connections"),
    st<StErrors>("/rest/system/error"),
  ]);
  const connected = Object.values(conns.connections ?? {}).filter((c) => c.connected).length;
  return txt({
    version: ver.version,
    os: `${ver.os}/${ver.arch}`,
    myID: String(sys.myID ?? "").slice(0, 7),
    uptime_h: Math.round((sys.uptime ?? 0) / 360) / 10,
    folders: (cfg.folders ?? []).length,
    devices_total: (cfg.devices ?? []).length,
    devices_connected: connected,
    system_errors: (errs.errors ?? []).map((e) => typeof e === "string" ? e : e.message ?? e),
  });
});

server.registerTool("syncthing_folders", {
  description:
    "Per-folder status: label, path, type (sendreceive/receiveencrypted), paused flag, state, files and deletes still to sync, pull errors.",
  inputSchema: {},
}, async () => {
  const cfg = await st<StConfig>("/rest/config");
  const rows = [];
  for (const f of cfg.folders ?? []) {
    let s: StDbStatus = {};
    try {
      s = await st<StDbStatus>(`/rest/db/status?folder=${encodeURIComponent(f.id)}`);
    } catch { /* */ }
    rows.push({
      label: f.label || f.id,
      id: f.id,
      path: f.path,
      type: f.type,
      paused: !!f.paused,
      state: s.state ?? "?",
      needFiles: s.needFiles ?? 0,
      needDeletes: s.needDeletes ?? 0,
      pullErrors: s.pullErrors ?? s.errors ?? 0,
      globalFiles: s.globalFiles ?? 0,
    });
  }
  return txt(rows);
});

server.registerTool("syncthing_conflicts", {
  description:
    "Finds Syncthing conflict files (*.sync-conflict-*) in the synced folders; each one needs to be resolved or removed.",
  inputSchema: {},
}, async () => {
  const cfg = await st<StConfig>("/rest/config");
  const found: string[] = [];
  for (const f of cfg.folders ?? []) {
    for await (
      const e of walk(
        f.path,
        (e) => e.isFile && e.name.includes(".sync-conflict-"),
        (n) => n === "node_modules" || n === ".stversions",
      )
    ) found.push(e);
  }
  return txt(found.length ? { count: found.length, files: found } : "No *.sync-conflict-* files found. ✓");
});

/** Files tracked by git in `repoAbs` (read-only `git ls-files`). Empty when it is not a repository or git fails. */
async function gitTracked(repoAbs: string): Promise<string[]> {
  try {
    const cmd = new Deno.Command("git", { args: ["-C", repoAbs, "ls-files", "-z"], stdout: "piped", stderr: "null" });
    const { code, stdout } = await cmd.output();
    if (code !== 0) return [];
    return new TextDecoder().decode(stdout).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

server.registerTool("syncthing_git_guard", {
  description:
    "For every git repository inside a 'sendreceive' folder, checks what Syncthing actually syncs, using the folder's expanded ignore patterns: whether .git and the git-tracked files are synced, not merely whether the repository folder is excluded. A synced .git is CRITICAL (repository corruption risk); synced tracked files are WARN (working-tree drift); only valuable gitignored files synced is OK (correct partition).",
  inputSchema: {},
}, async () => {
  const cfg = await st<StConfig>("/rest/config");
  const report: GitReportRow[] = [];
  const CAP = 5000; // cap on tracked files inspected per repository
  for (const f of cfg.folders ?? []) {
    if (f.type !== "sendreceive") continue;
    let pats: string[] = [];
    // Use `.expanded`, not `.ignore`: the raw lines are only `#include .stignore-common` (see ignore.ts).
    try {
      pats = (await st<{ expanded?: string[] }>(`/rest/db/ignores?folder=${encodeURIComponent(f.id)}`)).expanded ?? [];
    } catch { /* */ }
    const compiled = pats.map(compilePattern).filter((c): c is Compiled => c !== null);
    for await (
      const g of walk(
        f.path,
        (e) => e.isDirectory && e.name === ".git",
        (n) => n === "node_modules" || n === ".git" || n === ".stversions",
      )
    ) {
      const repoAbs = g.replace(/\/?\.git$/, "");
      const base = repoAbs.slice(f.path.length).replace(/^\/+/, "");
      const join = (sub: string) => (base ? `${base}/${sub}` : sub);
      const gitDirSynced = !isIgnored(join(".git"), compiled);
      // A synced .git is already CRITICAL: skip enumerating tracked files.
      const tracked = gitDirSynced ? [] : await gitTracked(repoAbs);
      const sample = tracked.slice(0, CAP);
      let exposed = 0;
      for (const t of sample) if (!isIgnored(join(t), compiled)) exposed++;
      const truncated = tracked.length > CAP;
      const risk = gitDirSynced
        ? "🔴 CRITICAL — .git synced (repository corruption risk)"
        : exposed > 0
        ? `🟡 WARN — ${exposed}${truncated ? "+" : ""}/${tracked.length} tracked files synced (working-tree drift)`
        : "🟢 OK — correct partition (only valuable gitignored files synced)";
      report.push({
        folder: f.label || f.id,
        repo: base || "(root)",
        gitDirSynced,
        trackedExposed: exposed,
        trackedTotal: tracked.length,
        ...(truncated ? { note: `inspected the first ${CAP} tracked files` } : {}),
        risk,
      });
    }
  }
  const critical = report.filter((r) => r.gitDirSynced).length;
  const warn = report.filter((r) => !r.gitDirSynced && r.trackedExposed > 0).length;
  return txt({
    checked: report.length,
    critical,
    warn,
    ok: report.length - critical - warn,
    repos: report.length ? report : "No git repository inside a sendreceive folder.",
  });
});

await server.connect(new StdioServerTransport());
