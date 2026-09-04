#!/usr/bin/env -S deno run --quiet --allow-read --allow-write --allow-run --allow-env --allow-sys=hostname --allow-net=127.0.0.1:8384
// claude-multi — CLI di gestione del setup multi-profilo di Claude Code / Claude Desktop.
//
//   claude-multi install [--dry-run]   materializza ~/.claude-multi, ~/.local/bin, unit, .desktop dal repo (idempotente)
//   claude-multi doctor  [--json]      verifica ogni invariante del setup, con il fix suggerito
//   claude-multi status  [--json]      stato completo: versioni, update, sync repo, profili, istanze attive
//   claude-multi sync    [--fetch]     allinea il repo (fetch + pull ff-only a tree pulito); --fetch forza il fetch
//   claude-multi update  [...]         passthrough a bin/claude-update (CLI + Desktop)
//   claude-multi usage   [...]         token e costo-equivalente per profilo/modello/progetto/agente (SQLite, cli/usage.ts)
//
// Principio: il repo è la fonte di verità, ~/.claude-multi è runtime materializzato da `install`.
// Nessuna dipendenza esterna: solo API Deno, così gira su una macchina nuova senza cache moduli.

import { DB_PATH, type GroupBy, ingest, openDb, printReport, report } from "./usage.ts";

const HOME = Deno.env.get("HOME") ?? "";
const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const RUNTIME = Deno.env.get("CLAUDE_MULTI_ROOT") ?? `${HOME}/.claude-multi`;
const BIN = `${HOME}/.local/bin`;
const LIB = `${HOME}/.local/lib`;
const CACHE = `${Deno.env.get("XDG_CACHE_HOME") ?? `${HOME}/.cache`}/claude-multi`;
const PROFILES = ["personal", "work"] as const;
const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");

type Status = "ok" | "warn" | "fail";
interface Check { id: string; status: Status; msg: string; fix?: string }

// ---------------------------------------------------------------- utilità
async function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const p = new Deno.Command(cmd, { args, cwd: opts.cwd, env: opts.env, stdout: "piped", stderr: "piped" });
    const r = await p.output();
    const dec = new TextDecoder();
    return { code: r.code, out: dec.decode(r.stdout).trim(), err: dec.decode(r.stderr).trim() };
  } catch {
    return { code: 127, out: "", err: `${cmd}: non trovato` };
  }
}
async function has(cmd: string) { return (await run("sh", ["-c", `command -v ${cmd}`])).code === 0; }
async function lstat(p: string) { try { return await Deno.lstat(p); } catch { return null; } }
async function readlink(p: string) { try { return await Deno.readLink(p); } catch { return null; } }
async function readText(p: string) { try { return await Deno.readTextFile(p); } catch { return null; } }
async function readJson<T = Record<string, unknown>>(p: string): Promise<T | null> {
  const t = await readText(p); if (t === null) return null;
  try { return JSON.parse(t) as T; } catch { return null; }
}
async function listDir(p: string) {
  const out: string[] = []; try { for await (const e of Deno.readDir(p)) out.push(e.name); } catch { /* assente */ }
  return out.sort();
}
function mode(st: Deno.FileInfo | null) { return st?.mode == null ? null : (st.mode & 0o777).toString(8); }
const ANSI = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" };
const icon: Record<Status, string> = { ok: `${ANSI.g}✓${ANSI.x}`, warn: `${ANSI.y}!${ANSI.x}`, fail: `${ANSI.r}✗${ANSI.x}` };

// ---------------------------------------------------------------- git / repo
async function repoState() {
  const g = (...a: string[]) => run("git", ["-C", REPO, ...a]);
  const isRepo = (await g("rev-parse", "--git-dir")).code === 0;
  if (!isRepo) return { path: REPO, isRepo: false };
  const branch = (await g("rev-parse", "--abbrev-ref", "HEAD")).out;
  const upstream = (await g("rev-parse", "--abbrev-ref", "@{u}")).out || null;
  const remote = (await g("remote", "get-url", "origin")).out || null;
  let ahead = 0, behind = 0;
  if (upstream) {
    const c = (await g("rev-list", "--left-right", "--count", "@{u}...HEAD")).out.split(/\s+/);
    behind = Number(c[0] ?? 0); ahead = Number(c[1] ?? 0);
  }
  const dirty = (await g("status", "--porcelain")).out.split("\n").filter(Boolean).length;
  const head = (await g("log", "-1", "--format=%h %s")).out;
  const fetchStamp = await lstat(`${CACHE}/fetch.stamp`);
  const fetchedAt = fetchStamp?.mtime ? fetchStamp.mtime.toISOString() : null;
  return { path: REPO, isRepo: true, branch, upstream, remote, ahead, behind, dirty, head, fetchedAt };
}

// ---------------------------------------------------------------- macchina
async function machine() {
  const graphical = !!(Deno.env.get("WAYLAND_DISPLAY") || Deno.env.get("DISPLAY") || Deno.env.get("XDG_CURRENT_DESKTOP"));
  const desktopPkg = await run("pacman", ["-Q", "claude-desktop"]);
  const desktopVersion = desktopPkg.code === 0 ? desktopPkg.out.split(/\s+/)[1]?.split("-")[0] ?? null : null;
  const systemd = await has("systemctl");
  const kde = (Deno.env.get("XDG_CURRENT_DESKTOP") ?? "").toUpperCase().includes("KDE") || await has("kbuildsycoca6");
  const cliBin = await run("readlink", ["-f", `${BIN}/claude-bin`]);
  const cliVersion = cliBin.code === 0 ? cliBin.out.split("/").pop() ?? null : null;
  const embedded: Record<string, string[]> = {};
  for (const [variant, dir] of [["personal", "Claude"], ["work", "Claude-Work"]] as const) {
    const v = (await listDir(`${HOME}/.config/${dir}/claude-code`)).filter((x) => /^\d+\.\d+\.\d+$/.test(x));
    if (v.length) embedded[variant] = v;
  }
  return { hostname: Deno.hostname(), graphical, kde, systemd, desktopVersion, embeddedCode: embedded, cliVersion, deno: Deno.version.deno };
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
async function running() {
  const cli: { pid: number; profile: string | null; cwd: string | null; embedded: boolean; version: string | null }[] = [];
  const desktop: { pid: number; variant: string }[] = [];
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
async function profileInfo(p: string) {
  const dir = `${RUNTIME}/${p}`;
  const link = async (name: string) => await readlink(`${dir}/${name}`);
  const conf = await readJson<{ mcpServers?: Record<string, unknown>; oauthAccount?: { emailAddress?: string } }>(`${dir}/.claude.json`);
  const plugins = await readJson<{ plugins?: Record<string, unknown> }>(`${dir}/plugins/installed_plugins.json`);
  const creds = await lstat(`${dir}/.credentials.json`);
  const skillsDir = `${dir}/skills`;
  const skills = await listDir(skillsDir);
  const skillsResolved: Record<string, string | null> = {};
  for (const s of skills) skillsResolved[s] = await readlink(`${skillsDir}/${s}`);
  return {
    dir,
    exists: !!(await lstat(dir)),
    claudeMd: await link("CLAUDE.md"),
    settings: await link("settings.json"),
    agents: await link("agents"), commands: await link("commands"), hooks: await link("hooks"), skillsLink: await link("skills"),
    skills: skillsResolved,
    credentials: creds ? { present: true, mode: mode(creds) } : { present: false, mode: null },
    account: conf?.oauthAccount?.emailAddress ?? null,
    mcp: Object.keys(conf?.mcpServers ?? {}),
    plugins: Object.keys(plugins?.plugins ?? {}),
  };
}

// ---------------------------------------------------------------- doctor
async function doctor(): Promise<Check[]> {
  const c: Check[] = [];
  const add = (id: string, status: Status, msg: string, fix?: string) => c.push({ id, status, msg, fix });
  const m = await machine();
  const repo = await repoState();

  // repo
  if (!repo.isRepo) add("repo", "fail", `${REPO} non è un repo git`, "git clone <remote> ~/.local/src/claude-multi");
  else {
    if (!repo.upstream) add("repo.upstream", "warn", `branch ${repo.branch} senza upstream: sync disattivo`, "git -C ~/.local/src/claude-multi push -u origin " + repo.branch);
    else if (repo.behind && repo.ahead) add("repo.sync", "fail", `divergente: ↓${repo.behind} ↑${repo.ahead}`, "git -C ~/.local/src/claude-multi pull --rebase (a mano)");
    else if (repo.behind) add("repo.sync", "warn", `config indietro di ${repo.behind} commit`, "claude-multi sync");
    else if (repo.ahead) add("repo.sync", "warn", `${repo.ahead} commit locali non pushati`, "git -C ~/.local/src/claude-multi push");
    else add("repo.sync", "ok", `allineato a ${repo.upstream} (${repo.head})`);
    if (repo.dirty) add("repo.dirty", "warn", `${repo.dirty} file modificati non committati nel repo`, "git -C ~/.local/src/claude-multi status");
  }

  // runtime shared → repo
  const sharedLink = await readlink(`${RUNTIME}/shared`);
  if (sharedLink === `${REPO}/shared`) add("runtime.shared", "ok", "~/.claude-multi/shared → repo");
  else if (await lstat(`${RUNTIME}/shared`)) add("runtime.shared", "fail", `~/.claude-multi/shared non punta al repo (${sharedLink ?? "dir reale"})`, "claude-multi install");
  else add("runtime.shared", "fail", "~/.claude-multi/shared assente", "claude-multi install");

  // profili
  for (const p of PROFILES) {
    const info = await profileInfo(p);
    if (!info.exists) { add(`profile.${p}`, "fail", `profilo ${p} assente`, "claude-multi install"); continue; }
    const wantMd = `${REPO}/profiles/${p}/CLAUDE.md`;
    if (info.claudeMd !== wantMd) add(`profile.${p}.claudemd`, "fail", `${p}/CLAUDE.md non punta al repo`, "claude-multi install");
    for (const [k, v] of Object.entries({ settings: info.settings, agents: info.agents, commands: info.commands, hooks: info.hooks })) {
      const want = k === "settings" ? "../shared/settings.json" : `../shared/${k}`;
      if (v !== want) add(`profile.${p}.${k}`, "fail", `${p}/${k === "settings" ? "settings.json" : k} → ${v ?? "non symlink"} (atteso ${want})`, "claude-multi install");
    }
    if (p === "personal" && info.skillsLink !== "../shared/skills") add("profile.personal.skills", "fail", "personal/skills deve puntare a ../shared/skills", "claude-multi install");
    if (p === "work" && info.skillsLink) add("profile.work.skills", "fail", "work/skills deve essere una dir reale con symlink selettivi", "claude-multi install");
    if (p === "personal") {
      const leak = Object.keys(info.skills).filter((s) => s.startsWith("clientapp"));
      if (leak.length) add("profile.personal.leak", "fail", `skill cliente caricate in personal: ${leak.join(", ")}`, "claude-multi install (rimuove da shared/skills)");
    }
    if (!info.credentials.present) add(`profile.${p}.login`, "warn", `${p}: nessuna credenziale, serve /login`, p === "work" ? "claude-work → /login" : "claude → /login");
    else if (info.credentials.mode !== "600") add(`profile.${p}.creds`, "fail", `${p}/.credentials.json mode ${info.credentials.mode}`, `chmod 600 ${info.dir}/.credentials.json`);
    if (info.exists) add(`profile.${p}`, "ok", `${p}: ${info.account ?? "account ?"} · mcp ${info.mcp.length} · plugin ${info.plugins.length}`);
    // file con segreti fuori regola nella root del profilo
    const junk = (await listDir(info.dir)).filter((f) => /\.(bak|backup|pre-|tmp\.)/.test(f) && /credentials|claude\.json|settings/.test(f));
    if (junk.length) add(`profile.${p}.junk`, "fail", `backup con token/account nel profilo: ${junk.join(", ")}`, `rm ${junk.map((f) => `${info.dir}/${f}`).join(" ")}`);
  }

  // binari e wrapper
  const wantClaude = `${REPO}/bin/claude`;
  const claudeLink = await readlink(`${BIN}/claude`);
  if (claudeLink === wantClaude) add("bin.claude", "ok", "~/.local/bin/claude → wrapper personal del repo");
  else if (claudeLink?.includes("claude/versions/")) add("bin.claude", "fail", "~/.local/bin/claude è il symlink dell'updater nativo (profilo sbagliato!)", "claude-multi install");
  else add("bin.claude", "fail", `~/.local/bin/claude → ${claudeLink ?? "file reale/assente"}`, "claude-multi install");
  for (const b of ["claude-work", "claude-multi", "claude-launch", "claude-update"]) {
    if ((await readlink(`${BIN}/${b}`)) !== `${REPO}/bin/${b}`) add(`bin.${b}`, "fail", `~/.local/bin/${b} non punta al repo`, "claude-multi install");
  }
  if (await lstat(`${BIN}/claude-multi-finalize`)) add("bin.finalize", "warn", "claude-multi-finalize è superato da `claude-multi doctor`", `rm ${BIN}/claude-multi-finalize`);
  if (!m.cliVersion) add("bin.claude-bin", "fail", "claude-bin non risolve a nessuna versione", "claude-multi update --cli");
  else {
    const versions = (await listDir(`${HOME}/.local/share/claude/versions`)).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
    add("bin.claude-bin", versions.length > 2 ? "warn" : "ok", `Claude Code ${m.cliVersion}${versions.length > 1 ? ` (+${versions.length - 1} versioni in cache)` : ""}`, versions.length > 2 ? "claude-multi update --cli (pota)" : undefined);
  }
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) add("stub", "warn", "~/.claude assente (stub di sicurezza)", "claude-multi install");
  else if (!stub.isDirectory) add("stub", "fail", "~/.claude non è una directory", "rm ~/.claude && claude-multi install");
  else if (mode(stub) !== "500") add("stub", "fail", `~/.claude mode ${mode(stub)} (atteso 500)`, "chmod 500 ~/.claude");
  else add("stub", "ok", "~/.claude stub read-only (500)");

  // zshrc
  const zsh = await readText(`${HOME}/.zshrc`) ?? "";
  if (!zsh.includes("# >>> claude-multi")) add("zshrc", "warn", "blocco claude-multi assente in ~/.zshrc", "claude-multi install");
  else if (!zsh.includes("claude-multi/personal") || zsh.includes("alias claude=")) add("zshrc", "fail", "blocco claude-multi in ~/.zshrc obsoleto (default work o alias claude)", "claude-multi install");
  else add("zshrc", "ok", "blocco ~/.zshrc aggiornato");

  // Syncthing: la folder claude-multi non deve più esistere
  if (await lstat(`${RUNTIME}/.stfolder`)) add("syncthing", "warn", "~/.claude-multi è ancora una folder Syncthing", "rimuovi la folder claude-multi da Syncthing (la config viaggia via git)");

  // MCP registry
  const mcp = await run("python3", [`${REPO}/shared/scripts/mcp-sync.py`, "--check"]);
  if (mcp.code === 0) add("mcp", "ok", "registry MCP in sync sui profili");
  else if (mcp.code === 1) add("mcp", "warn", "registry MCP fuori sync", "python3 ~/.local/src/claude-multi/shared/scripts/mcp-sync.py (a Claude chiuso)");
  else add("mcp", "warn", `mcp-sync --check: ${mcp.err || mcp.out}`.slice(0, 160));

  // update
  const upd = await readJson<{ cli: { outdated: boolean; latest: string }; desktop: { outdated: boolean; latest: string } }>(`${HOME}/.cache/claude-update/check.json`);
  if (upd?.cli?.outdated) add("update.cli", "warn", `Claude Code ${upd.cli.latest} disponibile`, "claude-multi update --cli");
  if (upd?.desktop?.outdated) add("update.desktop", "warn", `Claude Desktop ${upd.desktop.latest} disponibile`, "claude-multi update --desktop");
  if (!upd) add("update.check", "warn", "nessun check aggiornamenti in cache", "claude-multi update --check");

  // desktop
  if (m.desktopVersion) {
    const workBin = await lstat(`${LIB}/claude-desktop-work/claude-desktop-work`);
    const workAsar = await lstat(`${LIB}/claude-desktop-work/resources/app.asar`);
    const sysAsar = await lstat("/usr/lib/claude-desktop/resources/app.asar");
    if (!workBin || !workAsar) add("desktop.work", "fail", "variante Claude Work assente", "claude-desktop-work-rebuild");
    else if (sysAsar?.mtime && workAsar.mtime && sysAsar.mtime > workAsar.mtime) add("desktop.work", "fail", "variante Work più vecchia dell'app di sistema", "claude-desktop-work-rebuild");
    else add("desktop.work", "ok", `Claude Desktop ${m.desktopVersion} + variante Work allineata`);
    for (const d of ["com.anthropic.Claude.desktop", "claude-desktop-work.desktop"]) {
      const t = await readText(`${HOME}/.local/share/applications/${d}`);
      if (!t) add(`desktop.entry.${d}`, "fail", `${d} assente`, "claude-multi install");
      else if (!t.includes("claude-launch")) add(`desktop.entry.${d}`, "fail", `${d} non passa da claude-launch`, "claude-multi install");
    }
    if ((await readlink(`${LIB}/claude-update-gui`)) !== `${REPO}/lib/claude-update-gui`) add("desktop.gui", "fail", "~/.local/lib/claude-update-gui non punta al repo", "claude-multi install");
    if (m.systemd) {
      const t = await run("systemctl", ["--user", "is-enabled", "claude-update-check.timer"]);
      if (t.out !== "enabled") add("desktop.timer", "warn", `claude-update-check.timer: ${t.out || "assente"}`, "claude-multi install");
    }
    const handler = await readText(`${HOME}/.local/share/applications/claude-code-url-handler.desktop`);
    if (handler && !handler.includes("claude-bin")) add("desktop.urlhandler", "fail", "url-handler claude-cli:// non punta a claude-bin", "claude-multi install");
  }
  return c;
}

// ---------------------------------------------------------------- install
let DRY = false;
const actions: string[] = [];
function say(s: string) { actions.push(s); console.log(`  ${DRY ? `${ANSI.d}(dry)${ANSI.x} ` : ""}${s}`); }

async function backupAway(p: string) {
  const dest = `${p}.pre-repo-${STAMP}`;
  say(`${ANSI.y}→${ANSI.x} sposto ${p} in ${dest}`);
  if (!DRY) await Deno.rename(p, dest);
}
async function ensureSymlink(target: string, link: string, label = link) {
  const cur = await readlink(link);
  if (cur === target) return;
  const st = await lstat(link);
  if (st && !st.isSymlink) await backupAway(link);
  else if (st && !DRY) await Deno.remove(link);
  say(`${ANSI.g}+${ANSI.x} ${label} → ${target}`);
  if (!DRY) await Deno.symlink(target, link);
}
async function ensureDir(p: string, m?: number) {
  if (await lstat(p)) return;
  say(`${ANSI.g}+${ANSI.x} mkdir ${p}`);
  if (!DRY) await Deno.mkdir(p, { recursive: true, mode: m });
}
async function ensureCopy(src: string, dst: string) {
  const a = await readText(src); const b = await readText(dst);
  if (a !== null && a === b) return;
  say(`${ANSI.g}+${ANSI.x} copio ${dst}`);
  if (!DRY) { await Deno.mkdir(dst.slice(0, dst.lastIndexOf("/")), { recursive: true }); await Deno.copyFile(src, dst); }
}

const ZSH_BEGIN = "# >>> claude-multi (multi-account) >>>";
const ZSH_END = "# <<< claude-multi <<<";
const ZSH_BLOCK = `${ZSH_BEGIN}
# Gestito da \`claude-multi install\` (repo ~/.local/src/claude-multi): non editare a mano.
# \`claude\` = profilo personal (default), \`claude-work\` (cw) = profilo work.
export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-$HOME/.claude-multi/personal}"
export DISABLE_AUTOUPDATER=1
alias cw='claude-work'
alias clp='claude'
${ZSH_END}`;

async function install() {
  const m = await machine();
  console.log(`${ANSI.b}claude-multi install${ANSI.x} — repo ${REPO} → runtime ${RUNTIME} (${m.hostname}${DRY ? ", dry-run" : ""})\n`);

  // 1. runtime + marketplaces fuori da shared (per-macchina, riclonabili)
  await ensureDir(RUNTIME);
  const sharedIsDir = (await lstat(`${RUNTIME}/shared`))?.isDirectory && !(await lstat(`${RUNTIME}/shared`))?.isSymlink;
  const oldMk = `${RUNTIME}/shared/plugins/marketplaces`;
  if (sharedIsDir && await lstat(oldMk) && !(await lstat(`${RUNTIME}/marketplaces`))) {
    say(`${ANSI.y}→${ANSI.x} sposto ${oldMk} in ${RUNTIME}/marketplaces`);
    if (!DRY) await Deno.rename(oldMk, `${RUNTIME}/marketplaces`);
  }
  await ensureDir(`${RUNTIME}/marketplaces`);

  // 2. shared → repo
  await ensureSymlink(`${REPO}/shared`, `${RUNTIME}/shared`, "~/.claude-multi/shared");

  // 3. profili
  for (const p of PROFILES) {
    const dir = `${RUNTIME}/${p}`;
    await ensureDir(dir, 0o700);
    await ensureSymlink(`${REPO}/profiles/${p}/CLAUDE.md`, `${dir}/CLAUDE.md`, `${p}/CLAUDE.md`);
    await ensureSymlink("../shared/settings.json", `${dir}/settings.json`, `${p}/settings.json`);
    for (const d of ["agents", "commands", "hooks"]) await ensureSymlink(`../shared/${d}`, `${dir}/${d}`, `${p}/${d}`);
    await ensureDir(`${dir}/plugins`);
    await ensureSymlink("../../marketplaces", `${dir}/plugins/marketplaces`, `${p}/plugins/marketplaces`);
    if (p === "personal") await ensureSymlink("../shared/skills", `${dir}/skills`, "personal/skills");
    else {
      const sk = `${dir}/skills`;
      const st = await lstat(sk);
      if (st?.isSymlink) { say(`${ANSI.y}→${ANSI.x} work/skills era un symlink: diventa dir reale`); if (!DRY) await Deno.remove(sk); }
      await ensureDir(sk);
      for (const s of await listDir(`${REPO}/profiles/work/skills`)) await ensureSymlink(`${REPO}/profiles/work/skills/${s}`, `${sk}/${s}`, `work/skills/${s}`);
      // skill condivise selezionate per work: quelle già linkate restano; graphify è il default storico
      if (!(await lstat(`${sk}/graphify`)) && await lstat(`${REPO}/shared/skills/graphify`)) await ensureSymlink("../../shared/skills/graphify", `${sk}/graphify`, "work/skills/graphify");
    }
    const creds = await lstat(`${dir}/.credentials.json`);
    if (creds && mode(creds) !== "600") { say(`${ANSI.y}→${ANSI.x} chmod 600 ${p}/.credentials.json`); if (!DRY) await Deno.chmod(`${dir}/.credentials.json`, 0o600); }
  }

  // 4. ~/.local/bin
  await ensureDir(BIN);
  for (const b of await listDir(`${REPO}/bin`)) {
    if (b === "lib") continue;
    await ensureSymlink(`${REPO}/bin/${b}`, `${BIN}/${b}`, `~/.local/bin/${b}`);
  }
  await ensureSymlink(`${REPO}/shared/hooks/claude-distiller`, `${BIN}/claude-distiller`, "~/.local/bin/claude-distiller");
  await ensureSymlink(`${REPO}/shared/tools/stignore-gen/stignore-gen.ts`, `${BIN}/stignore-gen`, "~/.local/bin/stignore-gen");
  if (await lstat(`${BIN}/claude-multi-finalize`)) { say(`${ANSI.y}−${ANSI.x} rimuovo claude-multi-finalize (superato da doctor)`); if (!DRY) await Deno.remove(`${BIN}/claude-multi-finalize`); }
  await ensureDir(LIB);
  await ensureSymlink(`${REPO}/lib/claude-update-gui`, `${LIB}/claude-update-gui`, "~/.local/lib/claude-update-gui");

  // 5. stub ~/.claude (500: stat → ENOENT sui settings, nessun "Settings Error")
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) { say(`${ANSI.g}+${ANSI.x} stub ~/.claude (500)`); if (!DRY) { await Deno.mkdir(`${HOME}/.claude`); await Deno.chmod(`${HOME}/.claude`, 0o500); } }
  else if (stub.isDirectory && mode(stub) !== "500") { say(`${ANSI.y}→${ANSI.x} chmod 500 ~/.claude`); if (!DRY) await Deno.chmod(`${HOME}/.claude`, 0o500); }

  // 6. ~/.zshrc
  const zp = `${HOME}/.zshrc`; const zsh = await readText(zp);
  if (zsh !== null) {
    const re = new RegExp(`${ZSH_BEGIN.replace(/[()]/g, "\\$&")}[\\s\\S]*?${ZSH_END}`);
    const next = re.test(zsh) ? zsh.replace(re, ZSH_BLOCK) : `${zsh.trimEnd()}\n\n${ZSH_BLOCK}\n`;
    if (next !== zsh) { say(`${ANSI.y}→${ANSI.x} aggiorno il blocco claude-multi in ~/.zshrc`); if (!DRY) await Deno.writeTextFile(zp, next); }
  }

  // 7. systemd (solo macchine grafiche: la notifica va su KDE)
  if (m.graphical && m.systemd) {
    const ud = `${HOME}/.config/systemd/user`; await ensureDir(ud);
    for (const u of ["claude-update-check.service", "claude-update-check.timer"]) await ensureSymlink(`${REPO}/systemd/user/${u}`, `${ud}/${u}`, `systemd/user/${u}`);
    if (!DRY) {
      await run("systemctl", ["--user", "daemon-reload"]);
      const en = await run("systemctl", ["--user", "is-enabled", "claude-update-check.timer"]);
      if (en.out !== "enabled") { say(`${ANSI.g}+${ANSI.x} enable --now claude-update-check.timer`); await run("systemctl", ["--user", "enable", "--now", "claude-update-check.timer"]); }
    }
  }

  // 8. Claude Desktop (solo dove è installato)
  if (m.desktopVersion) {
    const apps = `${HOME}/.local/share/applications`;
    for (const d of await listDir(`${REPO}/desktop`)) if (d.endsWith(".desktop")) await ensureCopy(`${REPO}/desktop/${d}`, `${apps}/${d}`);
    for (const s of await listDir(`${REPO}/desktop/icons`)) await ensureCopy(`${REPO}/desktop/icons/${s}/claude-desktop-work.png`, `${HOME}/.local/share/icons/hicolor/${s}/apps/claude-desktop-work.png`);
    const handlerP = `${apps}/claude-code-url-handler.desktop`; const handler = await readText(handlerP);
    if (handler && /Exec=.*\/claude"? --handle-uri/.test(handler) && !handler.includes("claude-bin")) {
      say(`${ANSI.y}→${ANSI.x} url-handler claude-cli:// → claude-bin`);
      if (!DRY) await Deno.writeTextFile(handlerP, handler.replace(/^Exec=.*--handle-uri/m, `Exec="${BIN}/claude-bin" --handle-uri`));
    }
    if (!DRY) {
      if (await has("update-desktop-database")) await run("update-desktop-database", [apps]);
      if (await has("gtk-update-icon-cache")) await run("gtk-update-icon-cache", ["-q", `${HOME}/.local/share/icons/hicolor`]);
      if (await has("kbuildsycoca6")) await run("kbuildsycoca6", ["--noincremental"]);
    }
    const pkgdir = Deno.env.get("CLAUDE_DESKTOP_PKGDIR") ?? `${HOME}/build/claude-desktop`;
    if (!(await lstat(`${pkgdir}/PKGBUILD`))) {
      for (const f of ["PKGBUILD", "claude-desktop.install"]) await ensureCopy(`${REPO}/pkg/claude-desktop/${f}`, `${pkgdir}/${f}`);
    }
  } else {
    console.log(`  ${ANSI.d}Claude Desktop non installato: salto .desktop, icone, GUI, PKGBUILD${ANSI.x}`);
  }

  if (!actions.length) console.log(`  ${ANSI.g}✓${ANSI.x} già tutto materializzato, nulla da fare`);
  console.log();
  await printDoctor(await doctor());
}

// ---------------------------------------------------------------- output
async function printDoctor(checks: Check[]) {
  const order: Status[] = ["fail", "warn", "ok"];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  console.log(`${ANSI.b}claude-multi doctor${ANSI.x}`);
  for (const c of sorted) {
    console.log(`  ${icon[c.status]} ${c.msg}${c.fix && c.status !== "ok" ? `\n      ${ANSI.d}fix:${ANSI.x} ${c.fix}` : ""}`);
  }
  const n = (s: Status) => checks.filter((c) => c.status === s).length;
  console.log(`\n  ${n("ok")} ok · ${ANSI.y}${n("warn")} warn${ANSI.x} · ${ANSI.r}${n("fail")} fail${ANSI.x}`);
  return n("fail") ? 1 : 0;
}

async function status() {
  const [m, repo, inst] = await Promise.all([machine(), repoState(), running()]);
  const profiles: Record<string, unknown> = {};
  for (const p of PROFILES) profiles[p] = await profileInfo(p);
  const sync = await readJson(`${CACHE}/sync.json`);
  const update = await readJson(`${HOME}/.cache/claude-update/check.json`);
  const shared = {
    agents: (await listDir(`${REPO}/shared/agents`)).filter((f) => f.endsWith(".md") && f !== "AGENTS.md").map((f) => f.slice(0, -3)),
    commands: (await listDir(`${REPO}/shared/commands`)).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)),
    skills: await listDir(`${REPO}/shared/skills`),
    hooks: (await listDir(`${REPO}/shared/hooks`)).filter((f) => /\.(sh|js|py)$/.test(f)),
    rules: await listDir(`${REPO}/shared/rules`),
    mcpRegistry: Object.keys((await readJson<{ servers: Record<string, unknown> }>(`${REPO}/shared/mcp/servers.json`))?.servers ?? {}),
  };
  return { generatedAt: new Date().toISOString(), machine: m, repo, sync, update, shared, profiles, running: inst, doctor: await doctor() };
}

function printStatus(s: Awaited<ReturnType<typeof status>>) {
  const m = s.machine; const r = s.repo as Record<string, unknown>;
  console.log(`${ANSI.b}claude-multi status${ANSI.x} — ${m.hostname}`);
  console.log(`  Claude Code     ${m.cliVersion ?? "?"}${(s.update as { cli?: { outdated?: boolean; latest?: string } })?.cli?.outdated ? `  ${ANSI.y}⬆ ${(s.update as { cli: { latest: string } }).cli.latest}${ANSI.x}` : ""}`);
  console.log(`  Claude Desktop  ${m.desktopVersion ?? "non installato"}${(s.update as { desktop?: { outdated?: boolean; latest?: string } })?.desktop?.outdated ? `  ${ANSI.y}⬆ ${(s.update as { desktop: { latest: string } }).desktop.latest}${ANSI.x}` : ""}`);
  for (const [variant, vs] of Object.entries(m.embeddedCode)) console.log(`  Desktop ${variant.padEnd(8)} Claude Code embedded ${vs.join(", ")}`);
  console.log(`  Repo            ${r.branch ?? "?"} @ ${r.head ?? "?"}  ↓${r.behind ?? 0} ↑${r.ahead ?? 0} ✎${r.dirty ?? 0}  (${r.remote ?? "nessun remote"})`);
  console.log(`  Condiviso       ${s.shared.agents.length} agenti · ${s.shared.commands.length} comandi · ${s.shared.skills.length} skill · ${s.shared.hooks.length} hook · ${s.shared.mcpRegistry.length} MCP nel registry`);
  for (const p of PROFILES) {
    const i = s.profiles[p] as Awaited<ReturnType<typeof profileInfo>>;
    const mine = s.running.cli.filter((c) => c.profile === p);
    const active = `${mine.filter((c) => !c.embedded).length} cli + ${mine.filter((c) => c.embedded).length} desktop`;
    console.log(`  ${p.padEnd(15)} ${i.account ?? "—"} · mcp [${i.mcp.join(", ")}] · skill ${Object.keys(i.skills).length} · plugin ${i.plugins.length} · sessioni ${active}`);
  }
  if (s.running.desktop.length) console.log(`  Desktop attivi  ${s.running.desktop.map((d) => d.variant).join(", ")}`);
  console.log();
}

// ---------------------------------------------------------------- main
const [cmd = "help", ...rest] = Deno.args;
const flag = (f: string) => rest.includes(f);
switch (cmd) {
  case "install": DRY = flag("--dry-run"); await install(); break;
  case "doctor": {
    const c = await doctor();
    if (flag("--json")) console.log(JSON.stringify(c, null, 2)); else Deno.exit(await printDoctor(c));
    break;
  }
  case "status": {
    const s = await status();
    if (flag("--json")) console.log(JSON.stringify(s, null, 2)); else { printStatus(s); await printDoctor(s.doctor); }
    break;
  }
  case "sync": {
    const env: Record<string, string> = flag("--fetch") ? { CLAUDE_MULTI_FETCH_TTL: "0", CLAUDE_MULTI_FETCH_TIMEOUT: "15" } : {};
    const r = await run("bash", [`${REPO}/bin/lib/prelaunch.sh`], { env });
    if (r.err) console.error(r.err);
    const st = await readJson(`${CACHE}/sync.json`) as Record<string, unknown> | null;
    if (st) console.log(`repo ${st.upstream ? "" : "(senza upstream) "}↓${st.behind} ↑${st.ahead} ✎${st.dirty}${st.pulled ? `  pull +${st.pulled}` : ""}${st.fetch_ok ? "" : "  (fetch fallito: offline?)"}`);
    break;
  }
  case "update": {
    const p = new Deno.Command(`${REPO}/bin/claude-update`, { args: rest, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    Deno.exit((await p.output()).code);
  }
  case "usage": {
    const opt = (name: string, def?: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def; };
    const db = openDb();
    if (rest[0] === "ingest" || !flag("--no-ingest")) {
      const t0 = Date.now();
      const r = await ingest(db, { full: flag("--full") });
      if (rest[0] === "ingest" || r.files) console.error(`ingest: ${r.files} file letti, ${r.msgs} messaggi, ${r.skipped} invariati (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${DB_PATH}`);
      if (rest[0] === "ingest") break;
    }
    const by = (opt("--by", "profile") as GroupBy);
    const rep = report(db, { by, since: opt("--since", "30d"), profile: opt("--profile"), limit: Number(opt("--limit", "40")) });
    if (flag("--json")) console.log(JSON.stringify(rep, null, 2)); else printReport(rep);
    break;
  }
  // deno-lint-ignore no-fallthrough
  case "help": case "--help": case "-h":
  default:
    console.log(`claude-multi — gestione del setup multi-profilo Claude (repo ${REPO})

  install [--dry-run]   materializza runtime, wrapper, unit e .desktop dal repo (idempotente)
  doctor  [--json]      verifica le invarianti del setup, con fix suggerito
  status  [--json]      versioni, aggiornamenti, sync repo, profili, istanze attive
  sync    [--fetch]     allinea il repo (fetch se stantio, pull ff-only a tree pulito)
  update  [--cli|--desktop|--check [--json]]   aggiorna Claude Code / Claude Desktop
  usage   [ingest [--full]] [--by profile|model|project|agent|day|session|entrypoint]
          [--since 30d|7d|all|YYYY-MM-DD] [--profile p] [--limit n] [--no-ingest] [--json]
                        token e costo-equivalente dai transcript (SQLite in ~/.local/share/claude-multi)`);
    if (cmd !== "help" && cmd !== "--help" && cmd !== "-h") Deno.exit(2);
}
