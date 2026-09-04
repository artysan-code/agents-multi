// install.ts — materializza il runtime dal repo. Idempotente: rilanciabile quando vuoi, --dry-run per vedere.
// Regola: mai cancellare contenuto reale, si sposta in *.pre-repo-<stamp> e si dice.

import { AGENTS_SKILLS, ANSI, BIN, HOME, KINDS, type Kind, LIB, listDir, loadManifest, lstat, machine, mode, ownItems, printDoctor, PROFILES, type Profile, readText, readlink, REPO, run, RUNTIME, STAMP, has } from "./lib.ts";
import { doctor } from "./doctor.ts";

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
async function removeLink(p: string, why: string) {
  say(`${ANSI.y}−${ANSI.x} rimuovo ${p} (${why})`);
  if (!DRY) await Deno.remove(p);
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

/** Materializza <profilo>/<kind> secondo il manifest: "all" senza voci proprie → symlink alla dir condivisa;
 *  altrimenti dir reale con symlink selettivi (shared relativi, propri assoluti verso il repo). */
async function materializeKind(p: Profile, kind: Kind, spec: "all" | string[]) {
  const dir = `${RUNTIME}/${p}/${kind}`;
  const own = await ownItems(p, kind);
  if (spec === "all" && own.length === 0) { await ensureSymlink(`../shared/${kind}`, dir, `${p}/${kind}`); return; }
  const st = await lstat(dir);
  if (st?.isSymlink) { say(`${ANSI.y}→${ANSI.x} ${p}/${kind} era un symlink: diventa dir reale`); if (!DRY) await Deno.remove(dir); }
  await ensureDir(dir);
  const sharedNames = spec === "all" ? await listDir(`${REPO}/shared/${kind}`) : spec.map((n) => kind === "skills" || n.endsWith(".md") ? n : `${n}.md`);
  const expected = new Set<string>();
  for (const n of sharedNames) {
    if (!(await lstat(`${REPO}/shared/${kind}/${n}`))) { say(`${ANSI.r}!${ANSI.x} ${p}/${kind}: "${n}" non esiste in shared/${kind} (manifest da correggere)`); continue; }
    expected.add(n); await ensureSymlink(`../../shared/${kind}/${n}`, `${dir}/${n}`, `${p}/${kind}/${n}`);
  }
  for (const n of own) { expected.add(n); await ensureSymlink(`${REPO}/profiles/${p}/${kind}/${n}`, `${dir}/${n}`, `${p}/${kind}/${n}`); }
  // link non previsti dal manifest: si tolgono solo se sono symlink (contenuto reale resta e lo segnala il doctor)
  for (const n of await listDir(dir)) {
    if (expected.has(n)) continue;
    const s = await lstat(`${dir}/${n}`);
    if (s?.isSymlink) await removeLink(`${dir}/${n}`, "fuori manifest");
  }
}

export async function install(dry: boolean) {
  DRY = dry;
  const m = await machine();
  console.log(`${ANSI.b}claude-multi install${ANSI.x} — repo ${REPO} → runtime ${RUNTIME} (${m.hostname}${DRY ? ", dry-run" : ""})\n`);

  // 1. runtime + marketplaces fuori da shared (per-macchina, riclonabili)
  await ensureDir(RUNTIME);
  const sharedSt = await lstat(`${RUNTIME}/shared`);
  const oldMk = `${RUNTIME}/shared/plugins/marketplaces`;
  if (sharedSt?.isDirectory && !sharedSt.isSymlink && await lstat(oldMk) && !(await lstat(`${RUNTIME}/marketplaces`))) {
    say(`${ANSI.y}→${ANSI.x} sposto ${oldMk} in ${RUNTIME}/marketplaces`);
    if (!DRY) await Deno.rename(oldMk, `${RUNTIME}/marketplaces`);
  }
  await ensureDir(`${RUNTIME}/marketplaces`);

  // 2. skill installate da tool esterni in ~/.agents/skills → link assoluti in shared/skills (nel repo: poi commit)
  if (await lstat(AGENTS_SKILLS)) {
    for (const s of await listDir(AGENTS_SKILLS)) {
      if (!(await lstat(`${AGENTS_SKILLS}/${s}/SKILL.md`))) continue;
      if (!(await lstat(`${REPO}/shared/skills/${s}`))) await ensureSymlink(`${AGENTS_SKILLS}/${s}`, `${REPO}/shared/skills/${s}`, `shared/skills/${s} (da ~/.agents)`);
    }
  }
  // link rotti in shared/skills (path relativi della vecchia dir, skill disinstallate)
  for (const s of await listDir(`${REPO}/shared/skills`)) {
    const p = `${REPO}/shared/skills/${s}`; const st = await lstat(p);
    if (st?.isSymlink && !(await lstat(`${p}/SKILL.md`))) {
      const t = await readlink(p) ?? "";
      const name = t.split("/").pop() ?? s;
      if (await lstat(`${AGENTS_SKILLS}/${name}/SKILL.md`)) await ensureSymlink(`${AGENTS_SKILLS}/${name}`, p, `shared/skills/${s} (ricreato)`);
      else await removeLink(p, "link rotto, skill non più in ~/.agents");
    }
  }

  // 3. shared → repo
  await ensureSymlink(`${REPO}/shared`, `${RUNTIME}/shared`, "~/.claude-multi/shared");

  // 4. profili
  for (const p of PROFILES) {
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

  // 6. stub ~/.claude (500: stat → ENOENT sui settings, nessun "Settings Error")
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) { say(`${ANSI.g}+${ANSI.x} stub ~/.claude (500)`); if (!DRY) { await Deno.mkdir(`${HOME}/.claude`); await Deno.chmod(`${HOME}/.claude`, 0o500); } }
  else if (stub.isDirectory && mode(stub) !== "500") { say(`${ANSI.y}→${ANSI.x} chmod 500 ~/.claude`); if (!DRY) await Deno.chmod(`${HOME}/.claude`, 0o500); }

  // 7. ~/.zshrc
  const zp = `${HOME}/.zshrc`; const zsh = await readText(zp);
  if (zsh !== null) {
    const re = new RegExp(`${ZSH_BEGIN.replace(/[()]/g, "\\$&")}[\\s\\S]*?${ZSH_END}`);
    const next = re.test(zsh) ? zsh.replace(re, ZSH_BLOCK) : `${zsh.trimEnd()}\n\n${ZSH_BLOCK}\n`;
    if (next !== zsh) { say(`${ANSI.y}→${ANSI.x} aggiorno il blocco claude-multi in ~/.zshrc`); if (!DRY) await Deno.writeTextFile(zp, next); }
  }

  // 8. systemd (solo macchine grafiche: la notifica va su KDE)
  if (m.graphical && m.systemd) {
    const ud = `${HOME}/.config/systemd/user`; await ensureDir(ud);
    for (const u of ["claude-update-check.service", "claude-update-check.timer"]) await ensureSymlink(`${REPO}/systemd/user/${u}`, `${ud}/${u}`, `systemd/user/${u}`);
    if (!DRY) {
      await run("systemctl", ["--user", "daemon-reload"]);
      const en = await run("systemctl", ["--user", "is-enabled", "claude-update-check.timer"]);
      if (en.out !== "enabled") { say(`${ANSI.g}+${ANSI.x} enable --now claude-update-check.timer`); await run("systemctl", ["--user", "enable", "--now", "claude-update-check.timer"]); }
    }
  }

  // 9. Claude Desktop (solo dove è installato)
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
    console.log(`  ${ANSI.d}Claude Desktop non installato: salto .desktop, icone, GUI, PKGBUILD${ANSI.x}`);
  }

  if (!actions.length) console.log(`  ${ANSI.g}✓${ANSI.x} già tutto materializzato, nulla da fare`);
  console.log();
  return printDoctor(await doctor());
}
