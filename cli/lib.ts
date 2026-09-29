// lib.ts — constants, helpers and shared state reads used by every command.
// Zero dependencies: Deno APIs only. Nothing writes here — reading is everyone's job, writing
// belongs to install/mcp.

export const HOME = Deno.env.get("HOME") ?? "";
export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const RUNTIME = Deno.env.get("CLAUDE_MULTI_ROOT") ?? `${HOME}/.claude-multi`;
export const BIN = `${HOME}/.local/bin`;
export const LIB = `${HOME}/.local/lib`;
export const CACHE = `${Deno.env.get("XDG_CACHE_HOME") ?? `${HOME}/.cache`}/claude-multi`;
export const STATE = `${Deno.env.get("XDG_STATE_HOME") ?? `${HOME}/.local/state`}/claude-multi`;
export const DATA = `${Deno.env.get("XDG_DATA_HOME") ?? `${HOME}/.local/share`}/claude-multi`;
// stignore-gen runs only where Syncthing does; its git template is what init.templateDir points at.
export const SYNCTHING_CONFIG = `${HOME}/.local/state/syncthing/config.xml`;
export const STIGNORE_GEN_TEMPLATE = `${REPO}/shared/tools/stignore-gen/git-template`;
export const AGENTS_SKILLS = `${HOME}/.agents/skills`; // where external tools (skills CLI) install skills
export const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");

/** Reserved entries under RUNTIME that are not profiles. */
export const NON_PROFILE_DIRS = new Set(["shared", "marketplaces", "plugins"]);

export type Profile = string;
export type Status = "ok" | "warn" | "fail";
export interface Check { id: string; status: Status; msg: string; fix?: string }

export const ANSI = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", c: "\x1b[36m", x: "\x1b[0m" };
export const icon: Record<Status, string> = { ok: `${ANSI.g}✓${ANSI.x}`, warn: `${ANSI.y}!${ANSI.x}`, fail: `${ANSI.r}✗${ANSI.x}` };

// ---------------------------------------------------------------- helpers
export async function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const p = new Deno.Command(cmd, { args, cwd: opts.cwd, env: opts.env, stdout: "piped", stderr: "piped" });
    const r = await p.output();
    const dec = new TextDecoder();
    return { code: r.code, out: dec.decode(r.stdout).trim(), err: dec.decode(r.stderr).trim() };
  } catch {
    return { code: 127, out: "", err: `${cmd}: not found` };
  }
}
export async function has(cmd: string) { return (await run("sh", ["-c", `command -v ${cmd}`])).code === 0; }
export async function lstat(p: string) { try { return await Deno.lstat(p); } catch { return null; } }
export async function stat(p: string) { try { return await Deno.stat(p); } catch { return null; } }
export async function readlink(p: string) { try { return await Deno.readLink(p); } catch { return null; } }
export async function readText(p: string) { try { return await Deno.readTextFile(p); } catch { return null; } }
export async function readJson<T = Record<string, unknown>>(p: string): Promise<T | null> {
  const t = await readText(p); if (t === null) return null;
  try { return JSON.parse(t) as T; } catch { return null; }
}
export async function listDir(p: string) {
  const out: string[] = []; try { for await (const e of Deno.readDir(p)) out.push(e.name); } catch { /* missing */ }
  return out.sort();
}
export function mode(st: Deno.FileInfo | null) { return st?.mode == null ? null : (st.mode & 0o777).toString(8); }
export function expandHome(p: string) { return p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p; }
export function shortHome(p: string) { return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p; }

// ---------------------------------------------------------------- profile manifest
export interface Manifest {
  description?: string;
  /** "all" = symlink the whole shared directory; a list = real directory with selective symlinks
   *  (plus whatever the profile owns) */
  skills: "all" | string[];
  agents: "all" | string[];
  commands: "all" | string[];
  /** Claude Desktop user-data-dir. Omitted = derived by convention, see desktopDir(). */
  desktopDir?: string;
  /** Launcher command that starts this profile. Omitted = `claude-<name>`, see commandOf(). */
  command?: string;
  /** Shell alias for the launcher, written into the managed ~/.zshrc block. */
  alias?: string;
  /** Switch off what the account brings in: the claude.ai connectors and the organisation's synced
   *  plugins. Applied by the launchers (bin/claude, bin/claude-launch), not by install. */
  disableAccountMcp?: boolean;
}
const MANIFEST_DEFAULT: Manifest = { skills: "all", agents: "all", commands: "all" };

export async function loadManifest(p: Profile): Promise<Manifest> {
  const m = await readJson<Partial<Manifest>>(`${REPO}/profiles/${p}/profile.json`);
  return { ...MANIFEST_DEFAULT, ...(m ?? {}) };
}

/** Profiles declared in the repo — the source of truth. Any directory holding a profile.json. */
export async function profileNames(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (const n of await listDir(`${REPO}/profiles`)) {
    if (n.startsWith(".")) continue;
    if (await stat(`${REPO}/profiles/${n}/profile.json`)) out.push(n);
  }
  return out;
}

/** The command that launches a profile. The manifest wins; otherwise `claude-<name>`, which is
 *  what a profile added by hand gets without having to say so. */
export function commandOf(p: Profile, m: Manifest): string {
  return m.command?.trim() || `claude-${p}`;
}

/** Every declared profile with its launcher command and optional alias, in profile order.
 *  The launcher is one script (bin/claude) linked under each command name: it identifies its
 *  profile from the name it was invoked as, so a new profile needs no new file. */
export async function launchers(): Promise<{ profile: Profile; command: string; alias?: string }[]> {
  const out: { profile: Profile; command: string; alias?: string }[] = [];
  for (const p of await profileNames()) {
    const m = await loadManifest(p);
    out.push({ profile: p, command: commandOf(p, m), alias: m.alias?.trim() || undefined });
  }
  return out;
}

export const ZSH_BEGIN = "# >>> claude-multi (multi-account) >>>";
export const ZSH_END = "# <<< claude-multi <<<";

/** The managed ~/.zshrc block, written from the manifests: launchers, their aliases, and the
 *  default profile — the one whose command is plain `claude`, falling back to the first declared. */
export async function zshBlock(): Promise<string> {
  const ls = await launchers();
  const def = ls.find((l) => l.command === "claude") ?? ls[0];
  const lines = ls.map((l) => `# \`${l.command}\`${l.alias ? ` (${l.alias})` : ""} = ${l.profile} profile`);
  const aliases = ls.filter((l) => l.alias).map((l) => `alias ${l.alias}='${l.command}'`);
  return [
    ZSH_BEGIN,
    "# Managed by `claude-multi install`: do not edit by hand.",
    ...lines,
    `export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-${RUNTIME}/${def?.profile ?? ""}}"`,
    "export DISABLE_AUTOUPDATER=1",
    ...aliases,
    ZSH_END,
  ].join("\n");
}

/** Profiles materialised under RUNTIME. Used to spot leftovers the repo no longer declares. */
export async function runtimeProfiles(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (const n of await listDir(RUNTIME)) {
    if (n.startsWith(".") || NON_PROFILE_DIRS.has(n)) continue;
    const st = await lstat(`${RUNTIME}/${n}`);
    if (st?.isDirectory) out.push(n);
  }
  return out;
}

/** Claude Desktop data dir for a profile: manifest wins, otherwise convention.
 *  `~/.config/Claude-<Name>` when it exists, else `~/.config/Claude` (Desktop's own default). */
export async function desktopDir(p: Profile, manifest?: Manifest): Promise<string> {
  const m = manifest ?? await loadManifest(p);
  if (m.desktopDir) return expandHome(m.desktopDir);
  const suffixed = `${HOME}/.config/Claude-${p.charAt(0).toUpperCase()}${p.slice(1)}`;
  return (await lstat(suffixed)) ? suffixed : `${HOME}/.config/Claude`;
}

export const KINDS = ["skills", "agents", "commands"] as const;
export type Kind = typeof KINDS[number];
/** Items the profile owns for a kind (profiles/<p>/<kind>/*), always mounted. */
export async function ownItems(p: Profile, kind: Kind) { return await listDir(`${REPO}/profiles/${p}/${kind}`); }

// ---------------------------------------------------------------- git / repo
export async function repoState() {
  const g = (...a: string[]) => run("git", ["-C", REPO, ...a]);
  const isRepo = (await g("rev-parse", "--git-dir")).code === 0;
  if (!isRepo) return { path: REPO, isRepo: false as const };
  const branch = (await g("rev-parse", "--abbrev-ref", "HEAD")).out;
  const upstream = (await g("rev-parse", "--abbrev-ref", "@{u}")).out || null;
  const remote = (await g("remote", "get-url", "origin")).out || null;
  let ahead = 0, behind = 0;
  if (upstream) {
    const c = (await g("rev-list", "--left-right", "--count", "@{u}...HEAD")).out.split(/\s+/);
    behind = Number(c[0] ?? 0); ahead = Number(c[1] ?? 0);
  }
  const dirtyFiles = (await g("status", "--porcelain")).out.split("\n").filter(Boolean);
  const head = (await g("log", "-1", "--format=%h %s")).out;
  const headDate = (await g("log", "-1", "--format=%cI")).out;
  const fetchStamp = await lstat(`${CACHE}/fetch.stamp`);
  const fetchedAt = fetchStamp?.mtime ? fetchStamp.mtime.toISOString() : null;
  return { path: REPO, isRepo: true as const, branch, upstream, remote, ahead, behind, dirty: dirtyFiles.length, dirtyFiles, head, headDate, fetchedAt };
}

// ---------------------------------------------------------------- machine
export async function machine() {
  // Over ssh the session variables are absent: without this check install would think it is on a
  // headless box and silently skip systemd units and menu entries.
  const rt = Deno.env.get("XDG_RUNTIME_DIR");
  const graphical = !!(Deno.env.get("WAYLAND_DISPLAY") || Deno.env.get("DISPLAY") || Deno.env.get("XDG_CURRENT_DESKTOP")) ||
    !!(rt && await lstat(`${rt}/wayland-0`)) || !!(await lstat("/tmp/.X11-unix/X0"));
  const desktopPkg = await run("pacman", ["-Q", "claude-desktop"]);
  const desktopVersion = desktopPkg.code === 0 ? desktopPkg.out.split(/\s+/)[1]?.split("-")[0] ?? null : null;
  const systemd = await has("systemctl");
  const kde = (Deno.env.get("XDG_CURRENT_DESKTOP") ?? "").toUpperCase().includes("KDE") || await has("kbuildsycoca6");
  const cliBin = await run("readlink", ["-f", `${BIN}/claude-bin`]);
  const cliVersion = cliBin.code === 0 ? cliBin.out.split("/").pop() ?? null : null;
  const cliVersions = (await listDir(`${HOME}/.local/share/claude/versions`)).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const embedded: Record<string, string[]> = {};
  for (const p of await profileNames()) {
    const v = (await listDir(`${await desktopDir(p)}/claude-code`)).filter((x) => /^\d+\.\d+\.\d+$/.test(x));
    if (v.length) embedded[p] = v;
  }
  return { hostname: Deno.hostname(), graphical, kde, systemd, desktopVersion, embeddedCode: embedded, cliVersion, cliVersions, deno: Deno.version.deno };
}

// ---------------------------------------------------------------- running instances
// Classified by real executable (/proc/<pid>/exe), not by command line: a shell whose snapshot
// mentions "claude/versions" is not a session. /proc is read through readlink/cat (--allow-run)
// because Deno without --allow-all refuses to read /proc/<pid>/* directly.
async function procInfo(pid: number) {
  const exe = (await run("readlink", [`/proc/${pid}/exe`])).out || null;
  const cwd = (await run("readlink", [`/proc/${pid}/cwd`])).out || null;
  const env = (await run("cat", [`/proc/${pid}/environ`])).out;
  const m = env.split("\0").find((e) => e.startsWith("CLAUDE_CONFIG_DIR="));
  const profile = m ? m.slice("CLAUDE_CONFIG_DIR=".length).split("/").pop() ?? null : null;
  return { exe, cwd, profile };
}
export interface CliProc {
  pid: number; profile: string | null; cwd: string | null; embedded: boolean; version: string | null;
  /** Session id and model, parsed off the command line. Several sessions of the same profile look
   *  identical without them — which is exactly what Desktop does when you open a few tabs. */
  session: string | null; model: string | null;
  /** When the session's transcript was last written: a running process is not a working one. */
  lastActivity: string | null;
}

/** Claude Code stores a session at projects/<cwd with slashes turned into dashes>/<id>.jsonl, so
 *  the transcript can be addressed directly from what the process tells us — no directory walk. */
export function transcriptPath(profile: string, cwd: string | null, session: string | null) {
  if (!cwd || !session) return null;
  return `${RUNTIME}/${profile}/projects/${cwd.replace(/\//g, "-")}/${session}.jsonl`;
}
export async function running() {
  const cli: CliProc[] = [];
  const desktop: { pid: number; variant: Profile }[] = [];
  // Desktop binaries are named after the profile they serve (claude-desktop, claude-desktop-work…),
  // so the profile is read back off the executable path rather than a fixed table.
  const pg = await run("pgrep", ["-af", "claude/versions/|/claude-code/[0-9.]+/claude |claude-desktop[a-z-]*/claude-desktop"]);
  for (const line of pg.out.split("\n").filter(Boolean)) {
    const [pidS, ...rest] = line.split(" "); const pid = Number(pidS); const cmd = rest.join(" ");
    if (cmd.includes("--type=")) continue; // Electron child processes
    const { exe, cwd, profile } = await procInfo(pid);
    if (!exe) continue;
    const embedded = exe.match(/\/claude-code\/([0-9.]+)\/claude$/);
    const native = exe.match(/claude\/versions\/([0-9.]+)$/);
    if (embedded || native) {
      const session = cmd.match(/--resume[= ]([0-9a-f-]{36})/)?.[1] ?? null;
      const tp = profile ? transcriptPath(profile, cwd, session) : null;
      const st = tp ? await stat(tp) : null;
      cli.push({
        pid, profile, cwd, embedded: !!embedded, version: (embedded ?? native)![1], session,
        model: cmd.match(/--model[= ]([\w.-]+)/)?.[1] ?? null,
        lastActivity: st?.mtime?.toISOString() ?? null,
      });
      continue;
    }
    const desk = exe.match(/\/claude-desktop(?:-([a-z0-9-]+))?\/claude-desktop/);
    if (desk) desktop.push({ pid, variant: desk[1] ?? "personal" });
  }
  return { cli, desktop };
}

// ---------------------------------------------------------------- profiles
/** Plugin names in one of Claude Code's sync manifests (plugins/synced/<uuid>/manifest.json). */
export function syncedPluginNames(manifest: unknown): string[] {
  const plugins = (manifest as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.map((p) => (p as { name?: unknown })?.name).filter((n): n is string => typeof n === "string" && n.length > 0);
}

/** Plugins the organisation syncs into a profile, as `<name>@synced` — the ids enabledPlugins takes.
 *  Mirrors cm_account_mcp_settings in bin/lib/profiles.sh. */
export async function syncedPlugins(dir: string): Promise<string[]> {
  const names = new Set<string>();
  for (const bucket of await listDir(`${dir}/plugins/synced`)) {
    for (const n of syncedPluginNames(await readJson(`${dir}/plugins/synced/${bucket}/manifest.json`))) names.add(`${n}@synced`);
  }
  return [...names].sort();
}

/** One record of installed_plugins.json, as far as the checks read it. */
export interface PluginRecord { scope?: string; installPath?: string; projectPath?: string }

/** The two ways an install record goes wrong. `exists` answers for the paths the records name.
 *  - broken: its cache directory is gone, so Claude lists the plugin as "failed to load". It happens
 *    when a profile directory is moved, since the records hold absolute paths.
 *  - stale: a project or local record whose project directory is gone. It loads nowhere, and
 *    `claude plugin uninstall --scope …` reaches it only from inside that directory.
 *  A stale record is not also broken: nothing would ever load it. */
export function pluginRecordState(plugins: Record<string, unknown>, exists: (path: string) => boolean) {
  const broken: string[] = [];
  const stale: { id: string; scope: string; project: string }[] = [];
  for (const [id, recs] of Object.entries(plugins)) {
    for (const r of Array.isArray(recs) ? recs as PluginRecord[] : []) {
      if ((r.scope === "project" || r.scope === "local") && r.projectPath && !exists(r.projectPath)) stale.push({ id, scope: r.scope, project: r.projectPath });
      else if (r.installPath && !exists(r.installPath) && !broken.includes(id)) broken.push(id);
    }
  }
  return { broken, stale };
}

export async function profileInfo(p: Profile) {
  const dir = `${RUNTIME}/${p}`;
  const link = async (name: string) => await readlink(`${dir}/${name}`);
  const conf = await readJson<{ mcpServers?: Record<string, unknown>; oauthAccount?: { emailAddress?: string } }>(`${dir}/.claude.json`);
  const plugins = await readJson<{ plugins?: Record<string, unknown> }>(`${dir}/plugins/installed_plugins.json`);
  const present = new Set<string>();
  for (const recs of Object.values(plugins?.plugins ?? {})) {
    for (const r of Array.isArray(recs) ? recs as PluginRecord[] : []) {
      for (const path of [r.installPath, r.projectPath]) if (path && await lstat(path)) present.add(path);
    }
  }
  const { broken: brokenPlugins, stale: stalePlugins } = pluginRecordState(plugins?.plugins ?? {}, (path) => present.has(path));
  const creds = await lstat(`${dir}/.credentials.json`);
  const manifest = await loadManifest(p);
  const mounted: Record<Kind, Record<string, { link: string | null; broken: boolean }>> = { skills: {}, agents: {}, commands: {} };
  const kindLinks: Record<Kind, string | null> = { skills: null, agents: null, commands: null };
  for (const k of KINDS) {
    kindLinks[k] = await link(k);
    for (const n of await listDir(`${dir}/${k}`)) {
      if (k !== "skills" && !n.endsWith(".md")) continue;
      const path = `${dir}/${k}/${n}`;
      // "mounted" is what install put there, i.e. symlinks. Whatever Claude Code writes into the
      // runtime itself (skills/synced/<uuid>/, an agent created in session) is the profile's own
      // content: the manifest does not claim it and the checks must not read it as a stray mount.
      const link = await readlink(path);
      if (link === null) continue;
      mounted[k][k === "skills" ? n : n.slice(0, -3)] = { link, broken: !(await stat(k === "skills" ? `${path}/SKILL.md` : path)) };
    }
  }
  const deskDir = await desktopDir(p, manifest);
  const desktopConf = await readJson<{ mcpServers?: Record<string, unknown> }>(`${deskDir}/claude_desktop_config.json`);
  return {
    dir, exists: !!(await lstat(dir)), desktopDir: deskDir,
    manifest,
    claudeMd: await link("CLAUDE.md"), settings: await link("settings.json"), hooks: await link("hooks"),
    kindLinks, mounted,
    credentials: creds ? { present: true, mode: mode(creds) } : { present: false, mode: null },
    account: conf?.oauthAccount?.emailAddress ?? null,
    mcp: Object.keys(conf?.mcpServers ?? {}),
    mcpDesktop: Object.keys(desktopConf?.mcpServers ?? {}),
    plugins: Object.keys(plugins?.plugins ?? {}),
    brokenPlugins,
    stalePlugins,
    synced: await syncedPlugins(dir),
  };
}

// ---------------------------------------------------------------- shared (repo)
export async function sharedInventory() {
  const items = async (kind: Kind) => {
    const out: Record<string, { link: string | null; broken: boolean }> = {};
    for (const n of await listDir(`${REPO}/shared/${kind}`)) {
      if (kind !== "skills" && (!n.endsWith(".md") || n === "AGENTS.md")) continue;
      const path = `${REPO}/shared/${kind}/${n}`;
      out[kind === "skills" ? n : n.slice(0, -3)] = { link: await readlink(path), broken: !(await stat(kind === "skills" ? `${path}/SKILL.md` : path)) };
    }
    return out;
  };
  return {
    skills: await items("skills"), agents: await items("agents"), commands: await items("commands"),
    hooks: (await listDir(`${REPO}/shared/hooks`)).filter((f) => /\.(sh|js|py)$/.test(f)),
    rules: (await listDir(`${REPO}/shared/rules`)).map((f) => f.replace(/\.md$/, "")),
    agentsSkills: await listDir(AGENTS_SKILLS),
  };
}

// ---------------------------------------------------------------- output
export function printDoctor(checks: Check[]) {
  const order: Status[] = ["fail", "warn", "ok"];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  console.log(`${ANSI.b}claude-multi doctor${ANSI.x}`);
  for (const c of sorted) console.log(`  ${icon[c.status]} ${c.msg}${c.fix && c.status !== "ok" ? `\n      ${ANSI.d}fix:${ANSI.x} ${c.fix}` : ""}`);
  const n = (s: Status) => checks.filter((c) => c.status === s).length;
  console.log(`\n  ${n("ok")} pass · ${ANSI.y}${n("warn")} warn${ANSI.x} · ${ANSI.r}${n("fail")} fail${ANSI.x}`);
  return n("fail") ? 1 : 0;
}
