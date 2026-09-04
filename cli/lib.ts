// lib.ts — costanti, utilità e letture di stato condivise da tutti i comandi.
// Zero dipendenze: solo API Deno. Nessuna scrittura qui: leggere è di tutti, scrivere è di install/mcp.

export const HOME = Deno.env.get("HOME") ?? "";
export const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
export const RUNTIME = Deno.env.get("CLAUDE_MULTI_ROOT") ?? `${HOME}/.claude-multi`;
export const BIN = `${HOME}/.local/bin`;
export const LIB = `${HOME}/.local/lib`;
export const CACHE = `${Deno.env.get("XDG_CACHE_HOME") ?? `${HOME}/.cache`}/claude-multi`;
export const STATE = `${Deno.env.get("XDG_STATE_HOME") ?? `${HOME}/.local/state`}/claude-multi`;
export const DATA = `${Deno.env.get("XDG_DATA_HOME") ?? `${HOME}/.local/share`}/claude-multi`;
export const AGENTS_SKILLS = `${HOME}/.agents/skills`; // dove i tool esterni (skills CLI) installano le skill
export const PROFILES = ["personal", "work"] as const;
export type Profile = typeof PROFILES[number];
export const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
/** user-data-dir di Claude Desktop per profilo (config MCP della chat Desktop) */
export const DESKTOP_DIR: Record<Profile, string> = { personal: `${HOME}/.config/Claude`, work: `${HOME}/.config/Claude-Work` };

export type Status = "ok" | "warn" | "fail";
export interface Check { id: string; status: Status; msg: string; fix?: string }

export const ANSI = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", c: "\x1b[36m", x: "\x1b[0m" };
export const icon: Record<Status, string> = { ok: `${ANSI.g}✓${ANSI.x}`, warn: `${ANSI.y}!${ANSI.x}`, fail: `${ANSI.r}✗${ANSI.x}` };

// ---------------------------------------------------------------- utilità
export async function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const p = new Deno.Command(cmd, { args, cwd: opts.cwd, env: opts.env, stdout: "piped", stderr: "piped" });
    const r = await p.output();
    const dec = new TextDecoder();
    return { code: r.code, out: dec.decode(r.stdout).trim(), err: dec.decode(r.stderr).trim() };
  } catch {
    return { code: 127, out: "", err: `${cmd}: non trovato` };
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
  const out: string[] = []; try { for await (const e of Deno.readDir(p)) out.push(e.name); } catch { /* assente */ }
  return out.sort();
}
export function mode(st: Deno.FileInfo | null) { return st?.mode == null ? null : (st.mode & 0o777).toString(8); }
export function expandHome(p: string) { return p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p; }
export function shortHome(p: string) { return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p; }

// ---------------------------------------------------------------- manifest profilo
export interface Manifest {
  description?: string;
  /** "all" = symlink alla dir condivisa intera; lista = dir reale con symlink selettivi (+ quelli propri del profilo) */
  skills: "all" | string[];
  agents: "all" | string[];
  commands: "all" | string[];
}
const MANIFEST_DEFAULT: Manifest = { skills: "all", agents: "all", commands: "all" };
export async function loadManifest(p: Profile): Promise<Manifest> {
  const m = await readJson<Partial<Manifest>>(`${REPO}/profiles/${p}/profile.json`);
  return { ...MANIFEST_DEFAULT, ...(m ?? {}) };
}
export const KINDS = ["skills", "agents", "commands"] as const;
export type Kind = typeof KINDS[number];
/** elementi propri del profilo per un kind (profiles/<p>/<kind>/*), sempre montati */
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

// ---------------------------------------------------------------- macchina
export async function machine() {
  const graphical = !!(Deno.env.get("WAYLAND_DISPLAY") || Deno.env.get("DISPLAY") || Deno.env.get("XDG_CURRENT_DESKTOP"));
  const desktopPkg = await run("pacman", ["-Q", "claude-desktop"]);
  const desktopVersion = desktopPkg.code === 0 ? desktopPkg.out.split(/\s+/)[1]?.split("-")[0] ?? null : null;
  const systemd = await has("systemctl");
  const kde = (Deno.env.get("XDG_CURRENT_DESKTOP") ?? "").toUpperCase().includes("KDE") || await has("kbuildsycoca6");
  const cliBin = await run("readlink", ["-f", `${BIN}/claude-bin`]);
  const cliVersion = cliBin.code === 0 ? cliBin.out.split("/").pop() ?? null : null;
  const cliVersions = (await listDir(`${HOME}/.local/share/claude/versions`)).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  const embedded: Record<string, string[]> = {};
  for (const p of PROFILES) {
    const v = (await listDir(`${DESKTOP_DIR[p]}/claude-code`)).filter((x) => /^\d+\.\d+\.\d+$/.test(x));
    if (v.length) embedded[p] = v;
  }
  return { hostname: Deno.hostname(), graphical, kde, systemd, desktopVersion, embeddedCode: embedded, cliVersion, cliVersions, deno: Deno.version.deno };
}

// ---------------------------------------------------------------- istanze attive
// Classificazione per eseguibile reale (/proc/<pid>/exe), non per riga di comando: una shell che
// menziona "claude/versions" nel suo snapshot non è una sessione. /proc si legge via readlink/cat
// (--allow-run) perché Deno, senza --allow-all, nega la lettura diretta di /proc/<pid>/*.
async function procInfo(pid: number) {
  const exe = (await run("readlink", [`/proc/${pid}/exe`])).out || null;
  const cwd = (await run("readlink", [`/proc/${pid}/cwd`])).out || null;
  const env = (await run("cat", [`/proc/${pid}/environ`])).out;
  const m = env.split("\0").find((e) => e.startsWith("CLAUDE_CONFIG_DIR="));
  const profile = m ? m.slice("CLAUDE_CONFIG_DIR=".length).split("/").pop() ?? null : null;
  return { exe, cwd, profile };
}
export interface CliProc { pid: number; profile: string | null; cwd: string | null; embedded: boolean; version: string | null }
export async function running() {
  const cli: CliProc[] = [];
  const desktop: { pid: number; variant: Profile }[] = [];
  const pg = await run("pgrep", ["-af", "claude/versions/|/claude-code/[0-9.]+/claude |claude-desktop/claude-desktop|claude-desktop-work/claude-desktop-work"]);
  for (const line of pg.out.split("\n").filter(Boolean)) {
    const [pidS, ...rest] = line.split(" "); const pid = Number(pidS); const cmd = rest.join(" ");
    if (cmd.includes("--type=")) continue; // sotto-processi Electron
    const { exe, cwd, profile } = await procInfo(pid);
    if (!exe) continue;
    const embedded = exe.match(/\/claude-code\/([0-9.]+)\/claude$/);
    const native = exe.match(/claude\/versions\/([0-9.]+)$/);
    if (embedded || native) cli.push({ pid, profile, cwd, embedded: !!embedded, version: (embedded ?? native)![1] });
    else if (exe.endsWith("claude-desktop-work/claude-desktop-work")) desktop.push({ pid, variant: "work" });
    else if (exe.endsWith("/claude-desktop/claude-desktop")) desktop.push({ pid, variant: "personal" });
  }
  return { cli, desktop };
}

// ---------------------------------------------------------------- profili
export async function profileInfo(p: Profile) {
  const dir = `${RUNTIME}/${p}`;
  const link = async (name: string) => await readlink(`${dir}/${name}`);
  const conf = await readJson<{ mcpServers?: Record<string, unknown>; oauthAccount?: { emailAddress?: string } }>(`${dir}/.claude.json`);
  const plugins = await readJson<{ plugins?: Record<string, unknown> }>(`${dir}/plugins/installed_plugins.json`);
  const creds = await lstat(`${dir}/.credentials.json`);
  const mounted: Record<Kind, Record<string, { link: string | null; broken: boolean }>> = { skills: {}, agents: {}, commands: {} };
  const kindLinks: Record<Kind, string | null> = { skills: null, agents: null, commands: null };
  for (const k of KINDS) {
    kindLinks[k] = await link(k);
    for (const n of await listDir(`${dir}/${k}`)) {
      if (k !== "skills" && !n.endsWith(".md")) continue;
      const path = `${dir}/${k}/${n}`;
      mounted[k][k === "skills" ? n : n.slice(0, -3)] = { link: await readlink(path), broken: !(await stat(k === "skills" ? `${path}/SKILL.md` : path)) };
    }
  }
  const desktopConf = await readJson<{ mcpServers?: Record<string, unknown> }>(`${DESKTOP_DIR[p]}/claude_desktop_config.json`);
  return {
    dir, exists: !!(await lstat(dir)),
    manifest: await loadManifest(p),
    claudeMd: await link("CLAUDE.md"), settings: await link("settings.json"), hooks: await link("hooks"),
    kindLinks, mounted,
    credentials: creds ? { present: true, mode: mode(creds) } : { present: false, mode: null },
    account: conf?.oauthAccount?.emailAddress ?? null,
    mcp: Object.keys(conf?.mcpServers ?? {}),
    mcpDesktop: Object.keys(desktopConf?.mcpServers ?? {}),
    plugins: Object.keys(plugins?.plugins ?? {}),
  };
}

// ---------------------------------------------------------------- condiviso (repo)
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
  console.log(`\n  ${n("ok")} ok · ${ANSI.y}${n("warn")} warn${ANSI.x} · ${ANSI.r}${n("fail")} fail${ANSI.x}`);
  return n("fail") ? 1 : 0;
}
