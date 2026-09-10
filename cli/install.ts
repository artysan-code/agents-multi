// install.ts — materialise the runtime from the repository. Idempotent: run it whenever, --dry-run to look first.
// Rule: never delete real content. It is moved aside to *.pre-repo-<stamp>, and said out loud.

import { AGENTS_SKILLS, ANSI, BIN, HOME, KINDS, type Kind, LIB, listDir, loadManifest, lstat, machine, mode, ownItems, printDoctor, type Profile, profileNames, readText, readlink, REPO, run, RUNTIME, STAMP, has } from "./lib.ts";
import { doctor } from "./doctor.ts";

let DRY = false;
const actions: string[] = [];
function say(s: string) { actions.push(s); console.log(`  ${DRY ? `${ANSI.d}(dry)${ANSI.x} ` : ""}${s}`); }

async function backupAway(p: string) {
  const dest = `${p}.pre-repo-${STAMP}`;
  say(`${ANSI.y}→${ANSI.x} moving ${p} aside to ${dest}`);
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
async function removeLink(p: string, why: string) {
  say(`${ANSI.y}−${ANSI.x} removing ${p} (${why})`);
  if (!DRY) await Deno.remove(p);
}

const ZSH_BEGIN = "# >>> claude-multi (multi-account) >>>";
const ZSH_END = "# <<< claude-multi <<<";
const ZSH_BLOCK = `${ZSH_BEGIN}
# Managed by \`claude-multi install\`: do not edit by hand.
# \`claude\` = profilo personal (default), \`claude-work\` (cw) = profilo work.
export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-$HOME/.claude-multi/personal}"
export DISABLE_AUTOUPDATER=1
alias cw='claude-work'
alias clp='claude'
${ZSH_END}`;

/** Materialise <profile>/<kind> from the manifest: "all" with no owned items becomes a symlink to
 *  the shared directory; otherwise a real directory with selective symlinks (shared ones relative,
 *  owned ones absolute into the repository). */
async function materializeKind(p: Profile, kind: Kind, spec: "all" | string[]) {
  const dir = `${RUNTIME}/${p}/${kind}`;
  const own = await ownItems(p, kind);
  if (spec === "all" && own.length === 0) { await ensureSymlink(`../shared/${kind}`, dir, `${p}/${kind}`); return; }
  const st = await lstat(dir);
  if (st?.isSymlink) { say(`${ANSI.y}→${ANSI.x} ${p}/${kind} was a symlink: becoming a real directory`); if (!DRY) await Deno.remove(dir); }
  await ensureDir(dir);
  const sharedNames = spec === "all" ? await listDir(`${REPO}/shared/${kind}`) : spec.map((n) => kind === "skills" || n.endsWith(".md") ? n : `${n}.md`);
  const expected = new Set<string>();
  for (const n of sharedNames) {
    if (!(await lstat(`${REPO}/shared/${kind}/${n}`))) { say(`${ANSI.r}!${ANSI.x} ${p}/${kind}: "${n}" does not exist in shared/${kind} (fix the manifest)`); continue; }
    expected.add(n); await ensureSymlink(`../../shared/${kind}/${n}`, `${dir}/${n}`, `${p}/${kind}/${n}`);
  }
  for (const n of own) { expected.add(n); await ensureSymlink(`${REPO}/profiles/${p}/${kind}/${n}`, `${dir}/${n}`, `${p}/${kind}/${n}`); }
  // links the manifest does not call for: removed only when they are symlinks (real content stays,
  // and the doctor reports it)
  for (const n of await listDir(dir)) {
    if (expected.has(n)) continue;
    const s = await lstat(`${dir}/${n}`);
    if (s?.isSymlink) await removeLink(`${dir}/${n}`, "not in the manifest");
  }
}

export async function install(dry: boolean) {
  DRY = dry;
  const m = await machine();
  console.log(`${ANSI.b}claude-multi install${ANSI.x} — repo ${REPO} → runtime ${RUNTIME} (${m.hostname}${DRY ? ", dry-run" : ""})\n`);

  // 1. runtime + marketplaces outside shared (per-machine, re-clonable)
  await ensureDir(RUNTIME);
  const sharedSt = await lstat(`${RUNTIME}/shared`);
  const oldMk = `${RUNTIME}/shared/plugins/marketplaces`;
  if (sharedSt?.isDirectory && !sharedSt.isSymlink && await lstat(oldMk) && !(await lstat(`${RUNTIME}/marketplaces`))) {
    say(`${ANSI.y}→${ANSI.x} moving ${oldMk} to ${RUNTIME}/marketplaces`);
    if (!DRY) await Deno.rename(oldMk, `${RUNTIME}/marketplaces`);
  }
  await ensureDir(`${RUNTIME}/marketplaces`);

  // 2. skills installed by external tools in ~/.agents/skills → absolute links in shared/skills
  if (await lstat(AGENTS_SKILLS)) {
    for (const s of await listDir(AGENTS_SKILLS)) {
      if (!(await lstat(`${AGENTS_SKILLS}/${s}/SKILL.md`))) continue;
      if (!(await lstat(`${REPO}/shared/skills/${s}`))) await ensureSymlink(`${AGENTS_SKILLS}/${s}`, `${REPO}/shared/skills/${s}`, `shared/skills/${s} (da ~/.agents)`);
    }
  }
  // broken links in shared/skills (old relative paths, uninstalled skills)
  for (const s of await listDir(`${REPO}/shared/skills`)) {
    const p = `${REPO}/shared/skills/${s}`; const st = await lstat(p);
    if (st?.isSymlink && !(await lstat(`${p}/SKILL.md`))) {
      const t = await readlink(p) ?? "";
      const name = t.split("/").pop() ?? s;
      if (await lstat(`${AGENTS_SKILLS}/${name}/SKILL.md`)) await ensureSymlink(`${AGENTS_SKILLS}/${name}`, p, `shared/skills/${s} (ricreato)`);
      else await removeLink(p, "broken link, skill no longer in ~/.agents");
    }
  }

  // 3. shared → repo
  await ensureSymlink(`${REPO}/shared`, `${RUNTIME}/shared`, "~/.claude-multi/shared");

  // 4. profili
  for (const p of await profileNames()) {
    const dir = `${RUNTIME}/${p}`;
    await ensureDir(dir, 0o700);
    await ensureSymlink(`${REPO}/profiles/${p}/CLAUDE.md`, `${dir}/CLAUDE.md`, `${p}/CLAUDE.md`);
    await ensureSymlink("../shared/settings.json", `${dir}/settings.json`, `${p}/settings.json`);
    await ensureSymlink("../shared/hooks", `${dir}/hooks`, `${p}/hooks`);
    await ensureDir(`${dir}/plugins`);
    await ensureSymlink("../../marketplaces", `${dir}/plugins/marketplaces`, `${p}/plugins/marketplaces`);
    const manifest = await loadManifest(p);
    for (const k of KINDS) await materializeKind(p, k, manifest[k]);
    const creds = await lstat(`${dir}/.credentials.json`);
    if (creds && mode(creds) !== "600") { say(`${ANSI.y}→${ANSI.x} chmod 600 ${p}/.credentials.json`); if (!DRY) await Deno.chmod(`${dir}/.credentials.json`, 0o600); }
  }

  // 5. ~/.local/bin e ~/.local/lib
  await ensureDir(BIN);
  for (const b of await listDir(`${REPO}/bin`)) {
    if (b === "lib") continue;
    await ensureSymlink(`${REPO}/bin/${b}`, `${BIN}/${b}`, `~/.local/bin/${b}`);
  }
  await ensureSymlink(`${REPO}/shared/hooks/claude-distiller`, `${BIN}/claude-distiller`, "~/.local/bin/claude-distiller");
  await ensureSymlink(`${REPO}/shared/tools/stignore-gen/stignore-gen.ts`, `${BIN}/stignore-gen`, "~/.local/bin/stignore-gen");
  if (await lstat(`${BIN}/claude-multi-finalize`)) await removeLink(`${BIN}/claude-multi-finalize`, "superato da doctor");
  await ensureDir(LIB);
  await ensureSymlink(`${REPO}/lib/claude-update-gui`, `${LIB}/claude-update-gui`, "~/.local/lib/claude-update-gui");

  // 5b. the repository's git hooks (pre-commit: secret guard + type check)
  const hooks = (await run("git", ["-C", REPO, "config", "--get", "core.hooksPath"])).out;
  if (hooks !== ".githooks") { say(`${ANSI.g}+${ANSI.x} git core.hooksPath → .githooks (pre-commit)`); if (!DRY) await run("git", ["-C", REPO, "config", "core.hooksPath", ".githooks"]); }

  // 6. stub ~/.claude (500: stat → ENOENT sui settings, nessun "Settings Error")
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) { say(`${ANSI.g}+${ANSI.x} stub ~/.claude (500)`); if (!DRY) { await Deno.mkdir(`${HOME}/.claude`); await Deno.chmod(`${HOME}/.claude`, 0o500); } }
  else if (stub.isDirectory && mode(stub) !== "500") { say(`${ANSI.y}→${ANSI.x} chmod 500 ~/.claude`); if (!DRY) await Deno.chmod(`${HOME}/.claude`, 0o500); }

  // 7. ~/.zshrc
  const zp = `${HOME}/.zshrc`; const zsh = await readText(zp);
  if (zsh !== null) {
    const re = new RegExp(`${ZSH_BEGIN.replace(/[()]/g, "\\$&")}[\\s\\S]*?${ZSH_END}`);
    const next = re.test(zsh) ? zsh.replace(re, ZSH_BLOCK) : `${zsh.trimEnd()}\n\n${ZSH_BLOCK}\n`;
    if (next !== zsh) { say(`${ANSI.y}→${ANSI.x} updating the claude-multi block in ~/.zshrc`); if (!DRY) await Deno.writeTextFile(zp, next); }
  }

  // 8. systemd user units
  if (m.systemd) {
    const ud = `${HOME}/.config/systemd/user`; await ensureDir(ud);
    for (const u of await listDir(`${REPO}/systemd/user`)) await ensureSymlink(`${REPO}/systemd/user/${u}`, `${ud}/${u}`, `systemd/user/${u}`);
    if (!DRY) {
      await run("systemctl", ["--user", "daemon-reload"]);
      // The console serves itself: enabled everywhere systemd exists, including headless boxes
      // reached over an ssh tunnel. Without it you have to remember to run `serve` by hand.
      const wantEnabled = ["claude-multi-console.service"];
      // The update check raises desktop notifications, so it only makes sense with a session.
      if (m.graphical) wantEnabled.push("claude-update-check.timer");
      // llama-generate.service stays deliberately disabled: the shim starts it on demand and stops
      // it when idle, which keeps the VRAM free.
      if (m.graphical && await lstat(`${HOME}/.local/opt/llama-vulkan/bin/llama-server`)) wantEnabled.push("llama-embed.service", "llama-embed-shim.service");
      else if (m.graphical) console.log(`  ${ANSI.d}no llama-server (~/.local/opt/llama-vulkan): skipping llama-embed*.service — wiki search will have no semantic mode here${ANSI.x}`);
      for (const u of wantEnabled) {
        const en = await run("systemctl", ["--user", "is-enabled", u]);
        if (en.out !== "enabled") { say(`${ANSI.g}+${ANSI.x} enable --now ${u}`); await run("systemctl", ["--user", "enable", "--now", u]); }
      }
      // A unit whose file changed keeps running the old command until it is restarted.
      const st = await run("systemctl", ["--user", "show", "-p", "NeedDaemonReload", "--value", "claude-multi-console.service"]);
      if (st.out === "yes") { say(`${ANSI.y}\u2192${ANSI.x} restart claude-multi-console.service`); await run("systemctl", ["--user", "restart", "claude-multi-console.service"]); }
    }
  }


  // 9. Claude Desktop (only where it is installed)
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
    if (!(await lstat(`${pkgdir}/PKGBUILD`))) for (const f of ["PKGBUILD", "claude-desktop.install"]) await ensureCopy(`${REPO}/pkg/claude-desktop/${f}`, `${pkgdir}/${f}`);
  } else {
    console.log(`  ${ANSI.d}Claude Desktop is not installed: skipping desktop entries, icons, GUI and package files${ANSI.x}`);
  }

  if (!actions.length) console.log(`  ${ANSI.g}✓${ANSI.x} everything already materialised, nothing to do`);
  console.log();
  return printDoctor(await doctor());
}
