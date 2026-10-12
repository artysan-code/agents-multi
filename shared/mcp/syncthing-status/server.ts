#!/usr/bin/env -S deno run --allow-net=127.0.0.1:8384 --allow-read --allow-env --allow-run=git
// syncthing-status — read-only MCP server for the status of the local Syncthing instance.
// Talks only to Syncthing's REST API on localhost (ST_URL, default http://127.0.0.1:8384).
// The API key is read at runtime from Syncthing's config.xml (or the STGUI_APIKEY env variable)
// and is never persisted anywhere else.
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/stdio.js";
import { type Compiled, compilePattern, isIgnored } from "./ignore.ts";
import { dbStatusProblem, expandHome, gitRisk } from "./logic.ts";

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
  error?: string;
  invalid?: string;
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
  let xml: string;
  try {
    xml = Deno.readTextFileSync(configPath());
  } catch {
    throw new Error(`Syncthing is not set up here: no ${configPath()} and no STGUI_APIKEY env variable.`);
  }
  const m = xml.match(/<apikey>([^<]+)<\/apikey>/);
  if (!m) throw new Error("Syncthing API key not found (config.xml or STGUI_APIKEY env variable).");
  return m[1].trim();
}

/** The API key, read on the first call: the server starts on a machine without Syncthing, and its
 *  tools then answer with the reason instead of the server failing to start. */
let KEY: string | null = null;

const TIMEOUT_MS = 10_000;

/** GET `path` on the Syncthing REST API and return the parsed JSON, typed by the caller. Throws on a non-2xx status or a timeout. */
async function st<T = unknown>(path: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${BASE}${path}`, {
      headers: { "X-API-Key": KEY ??= apiKey() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`${path} -> no answer from Syncthing within ${TIMEOUT_MS / 1000}s`);
    }
    throw e;
  }
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return await r.json() as T;
}
const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
const txt = (o: unknown) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});

/** What a walk could not look at: directories it failed to read and ones it did not descend into (depth limit). */
interface WalkGaps {
  unreadable: string[];
  tooDeep: string[];
}

/** Walk `root` (at most `max` levels down), yielding the entries `pick` accepts and not descending into them or into `prune`d names. Gaps are recorded, never skipped silently. */
async function* walk(
  root: string,
  pick: (e: Deno.DirEntry) => boolean,
  prune: (n: string) => boolean,
  gaps: WalkGaps,
  max = 8,
  d = 0,
): AsyncGenerator<string> {
  if (d > max) {
    gaps.tooDeep.push(root);
    return;
  }
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(root)];
  } catch (e) {
    gaps.unreadable.push(`${root} (${errMsg(e)})`);
    return;
  }
  for (const e of entries) {
    const p = `${root}/${e.name}`;
    if (pick(e)) yield p;
    else if (e.isDirectory && !prune(e.name)) yield* walk(p, pick, prune, gaps, max, d + 1);
  }
}

/** The `warnings` entries for a walk's gaps (empty when it saw everything); long lists are cut to a few examples and a count. */
function gapNotes(gaps: WalkGaps): string[] {
  const some = (what: string, l: string[]) => [
    ...l.slice(0, 3).map((x) => `${what}: ${x}`),
    ...(l.length > 3 ? [`${what}: ... and ${l.length - 3} more`] : []),
  ];
  return [
    ...some("not visited, unreadable", gaps.unreadable),
    ...some("depth limit reached, not descended", gaps.tooDeep),
  ];
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
    const base = { label: f.label || f.id, id: f.id, path: f.path, type: f.type, paused: !!f.paused };
    let s: StDbStatus;
    try {
      s = await st<StDbStatus>(`/rest/db/status?folder=${encodeURIComponent(f.id)}`);
    } catch (e) {
      rows.push({ ...base, state: "?", error: `status unavailable: ${errMsg(e)}` });
      continue;
    }
    const problem = dbStatusProblem(s);
    rows.push({
      ...base,
      ...(problem ? { error: problem } : {}),
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
  const warnings: string[] = [];
  for (const f of cfg.folders ?? []) {
    const gaps: WalkGaps = { unreadable: [], tooDeep: [] };
    for await (
      const e of walk(
        expandHome(f.path, HOME),
        (e) => e.isFile && e.name.includes(".sync-conflict-"),
        (n) => n === "node_modules" || n === ".stversions" || n === ".git",
        gaps,
      )
    ) found.push(e);
    warnings.push(...gapNotes(gaps).map((w) => `${f.label || f.id}: ${w}`));
  }
  if (found.length) return txt({ count: found.length, files: found, ...(warnings.length ? { warnings } : {}) });
  if (warnings.length) {
    return txt({
      count: 0,
      message: "No *.sync-conflict-* files found in the parts visited, but the check is incomplete.",
      warnings,
    });
  }
  return txt("No *.sync-conflict-* files found. ✓");
});

/** Files tracked by git in `repoAbs` (read-only `git ls-files`), or the reason it failed. */
async function gitTracked(repoAbs: string): Promise<{ files: string[] } | { error: string }> {
  try {
    const cmd = new Deno.Command("git", { args: ["-C", repoAbs, "ls-files", "-z"], stdout: "piped", stderr: "piped" });
    const { code, stdout, stderr } = await cmd.output();
    if (code !== 0) {
      const why = new TextDecoder().decode(stderr).trim().split("\n")[0];
      return { error: `git ls-files failed (exit ${code})${why ? `: ${why}` : ""}` };
    }
    return { files: new TextDecoder().decode(stdout).split("\0").filter(Boolean) };
  } catch (e) {
    return { error: `git ls-files failed: ${errMsg(e)}` };
  }
}

server.registerTool("syncthing_git_guard", {
  description:
    "For every git repository inside a 'sendreceive' folder, checks what Syncthing actually syncs, using the folder's expanded ignore patterns: whether .git and the git-tracked files are synced, not merely whether the repository folder is excluded. A synced .git is CRITICAL (repository corruption risk); synced tracked files are WARN (working-tree drift); only valuable gitignored files synced is OK (correct partition).",
  inputSchema: {},
}, async () => {
  const cfg = await st<StConfig>("/rest/config");
  const report: GitReportRow[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const CAP = 5000; // cap on tracked files inspected per repository
  for (const f of cfg.folders ?? []) {
    if (f.type !== "sendreceive") continue;
    let pats: string[];
    // Use `.expanded`, not `.ignore`: the raw lines are only `#include .stignore-common` (see ignore.ts).
    try {
      pats = (await st<{ expanded?: string[] }>(`/rest/db/ignores?folder=${encodeURIComponent(f.id)}`)).expanded ?? [];
    } catch (e) {
      // Without the patterns every .git would look "not ignored": a false CRITICAL.
      skipped.push(`${f.label || f.id}: ignore patterns unavailable (${errMsg(e)}), folder not checked`);
      continue;
    }
    const compiled = pats.map(compilePattern).filter((c): c is Compiled => c !== null);
    const root = expandHome(f.path, HOME);
    const gaps: WalkGaps = { unreadable: [], tooDeep: [] };
    // `.git` is a directory, or a file in a git worktree.
    for await (
      const g of walk(
        root,
        (e) => (e.isDirectory || e.isFile) && e.name === ".git",
        (n) => n === "node_modules" || n === ".stversions",
        gaps,
      )
    ) {
      const repoAbs = g.replace(/\/?\.git$/, "");
      const base = repoAbs.slice(root.length).replace(/^\/+/, "");
      const join = (sub: string) => (base ? `${base}/${sub}` : sub);
      const gitDirSynced = !isIgnored(join(".git"), compiled);
      // A synced .git is already CRITICAL: skip enumerating tracked files.
      const listed = gitDirSynced ? { files: [] } : await gitTracked(repoAbs);
      const tracked = "files" in listed ? listed.files : null;
      const trackedError = "error" in listed ? listed.error : undefined;
      let exposed = 0;
      for (const t of (tracked ?? []).slice(0, CAP)) if (!isIgnored(join(t), compiled)) exposed++;
      const truncated = (tracked?.length ?? 0) > CAP;
      const risk = gitRisk({ gitDirSynced, tracked, trackedError, exposed, truncated });
      report.push({
        folder: f.label || f.id,
        repo: base || "(root)",
        gitDirSynced,
        trackedExposed: exposed,
        trackedTotal: tracked?.length ?? 0,
        ...(truncated
          ? { note: `inspected the first ${CAP} tracked files` }
          : trackedError
          ? { note: trackedError }
          : {}),
        risk,
      });
    }
    warnings.push(...gapNotes(gaps).map((w) => `${f.label || f.id}: ${w}`));
  }
  const critical = report.filter((r) => r.gitDirSynced).length;
  const warn = report.filter((r) => !r.gitDirSynced && r.trackedExposed > 0).length;
  const unknown = report.filter((r) => r.risk.startsWith("❔")).length;
  return txt({
    checked: report.length,
    critical,
    warn,
    unknown,
    ok: report.length - critical - warn - unknown,
    ...(skipped.length ? { skipped } : {}),
    ...(warnings.length ? { warnings } : {}),
    repos: report.length ? report : "No git repository inside a sendreceive folder.",
  });
});

await server.connect(new StdioServerTransport());
