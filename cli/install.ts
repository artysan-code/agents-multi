// install.ts — materialise the runtime from the repository. Idempotent: run it whenever, --dry-run to look first.
// Rule: never delete real content. It is moved aside to *.pre-repo-<stamp>, and said out loud.

import { AGENTS_SKILLS, ANSI, BIN, desktopDir, HOME, KINDS, launchers, shortHome, ZSH_BEGIN, ZSH_END, zshBlock, type Kind, LIB, listDir, loadManifest, lstat, machine, mode, ownItems, printDoctor, type Profile, profileNames, readText, readlink, REPO, run, RUNTIME, STAMP, has, STIGNORE_GEN_TEMPLATE, SYNCTHING_CONFIG } from "./lib.ts";
import { doctor } from "./doctor.ts";
import { syncSettings } from "./settings.ts";

let DRY = false;
const actions: string[] = [];
function say(s: string) { actions.push(s); console.log(`  ${DRY ? `${ANSI.d}(dry)${ANSI.x} ` : ""}${s}`); }

async function backupAway(p: string) {
  const dest = `${p}.pre-repo-${STAMP}`;
  say(`${ANSI.y}→${ANSI.x} moving ${p} aside to ${dest}`);
  if (!DRY) await Deno.rename(p, dest);
}
/** One .desktop per profile, written from desktop/entry.desktop.in. The profile whose data dir is
 *  Desktop's own ~/.config/Claude uses the system build and keeps Anthropic's file name and app_id;
 *  every other profile gets `claude-desktop-<name>`, matching the executable that
 *  claude-desktop-rebuild produces. The claude:// scheme stays with the default profile — two
 *  entries claiming it would make the handler ambiguous. */
async function writeDesktopEntries(apps: string) {
  const tpl = await readText(`${REPO}/desktop/entry.desktop.in`);
  if (tpl === null) return;
  const body = tpl.slice(tpl.indexOf("[Desktop Entry]"));
  const defaultProfile = (await launchers()).find((l) => l.command === "claude")?.profile;
  for (const p of await profileNames()) {
    const { file, text } = await desktopEntry(p, body, defaultProfile);
    const cur = await readText(`${apps}/${file}`);
    if (cur === text) continue;
    say(`${ANSI.g}+${ANSI.x} ${shortHome(`${apps}/${file}`)} (profile ${p})`);
    if (!DRY) { await Deno.mkdir(apps, { recursive: true }); await Deno.writeTextFile(`${apps}/${file}`, text); }
  }
}

/** The .desktop file for one profile: its name and its content. Split out of writeDesktopEntries
 *  so the shape can be asserted in a test instead of only on a real desktop. */
export async function desktopEntry(p: Profile, template: string, defaultProfile?: string) {
  const man = await loadManifest(p);
  const variant = (await desktopDir(p, man)) !== `${HOME}/.config/Claude`;
  const title = p.charAt(0).toUpperCase() + p.slice(1);
  const text = template
    .replaceAll("@NAME@", variant ? `Claude ${title}` : "Claude")
    .replaceAll("@COMMENT@", variant ? `Claude Desktop — ${title} profile (separate icon and app_id)` : "Desktop application for Claude.ai")
    .replaceAll("@LAUNCH@", `${BIN}/claude-launch`)
    .replaceAll("@PROFILE@", p)
    .replaceAll("@KEYWORD@", variant ? `${title};` : "")
    .replaceAll("@ICON@", variant ? `claude-desktop-${p}` : "claude-desktop")
    .replaceAll("@WMCLASS@", variant ? `claude-desktop-${p}` : "com.anthropic.Claude")
    .replaceAll("@MIME@", p === defaultProfile ? "MimeType=x-scheme-handler/claude;" : "# no scheme handler: claude:// belongs to the default profile");
  return { file: variant ? `claude-desktop-${p}.desktop` : "com.anthropic.Claude.desktop", text, variant };
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
/** A text file with @BIN@ filled in: a .desktop Exec= needs an absolute path, and the repository
 *  must not carry this machine's home directory. */
async function ensureRendered(src: string, dst: string) {
  const a = (await readText(src))?.replaceAll("@BIN@", BIN) ?? null; const b = await readText(dst);
  if (a === null || a === b) return;
  say(`${ANSI.g}+${ANSI.x} writing ${dst}`);
  if (!DRY) { await Deno.mkdir(dst.slice(0, dst.lastIndexOf("/")), { recursive: true }); await Deno.writeTextFile(dst, a); }
}
async function removeLink(p: string, why: string) {
  say(`${ANSI.y}−${ANSI.x} removing ${p} (${why})`);
  if (!DRY) await Deno.remove(p);
}


/** Materialise <profile>/<kind> as a real directory of selective symlinks: shared items relative,
 *  owned ones absolute into the repository.
 *
 *  It used to take a shortcut — "all" with no owned items became a single symlink to the shared
 *  directory — and that shortcut pointed a WRITABLE runtime path straight at the repository:
 *  ~/.claude-multi/personal/skills -> ../shared/skills -> <repo>/shared/skills. Claude Code writes
 *  into <config dir>/skills (the account skill sync lands a synced/<uuid>/ bucket there) and into
 *  agents/ and commands/, so its writes ended up inside the source of truth — untracked content in
 *  the repository, flagged broken by the doctor. And shared/ is shared by every profile: one
 *  account's cloud skills would reach the others the moment another profile mounted the lot.
 *  A directory of symlinks costs one link per item and keeps those writes in the runtime, where
 *  they belong. */
async function materializeKind(p: Profile, kind: Kind, spec: "all" | string[]) {
  const dir = `${RUNTIME}/${p}/${kind}`;
  const own = await ownItems(p, kind);
  const st = await lstat(dir);
  if (st?.isSymlink) { say(`${ANSI.y}→${ANSI.x} ${p}/${kind} was a symlink: becoming a real directory`); if (!DRY) await Deno.remove(dir); }
  await ensureDir(dir);
  // "all" mounts what really is an item of that kind, exactly like sharedInventory() counts them:
  // a skill is a directory with a SKILL.md, an agent or a command is a .md file — and AGENTS.md is
  // the catalog of the directory, not an agent. Anything else (a sync bucket, a stray file) is left
  // alone. The doctor still reports it: not mounting it is not the same as condoning it.
  const sharedNames = spec === "all"
    ? (await Promise.all((await listDir(`${REPO}/shared/${kind}`)).map(async (n) =>
        (kind === "skills" ? !!(await lstat(`${REPO}/shared/${kind}/${n}/SKILL.md`)) : n.endsWith(".md") && n !== "AGENTS.md") ? n : null)))
      .filter((n): n is string => n !== null)
    : spec.map((n) => kind === "skills" || n.endsWith(".md") ? n : `${n}.md`);
  const expected = new Set<string>();
  for (const n of sharedNames) {
    if (!(await lstat(`${REPO}/shared/${kind}/${n}`))) { say(`${ANSI.r}!${ANSI.x} ${p}/${kind}: "${n}" does not exist in shared/${kind} (fix the manifest)`); continue; }
    expected.add(n); await ensureSymlink(`../../shared/${kind}/${n}`, `${dir}/${n}`, `${p}/${kind}/${n}`);
  }
  for (const n of own) { expected.add(n); await ensureSymlink(`${REPO}/profiles/${p}/${kind}/${n}`, `${dir}/${n}`, `${p}/${kind}/${n}`); }
  // links the manifest does not call for: removed only when they are symlinks. Real content stays
  // untouched — it is the profile's own runtime (skills/synced/, agents created in session).
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
    // settings.json is generated (settings.ts): shared ⊕ the profile's patch ⊕ the manifest.
    const set = await syncSettings(p, { dry: DRY });
    if (set.adopted.length) say(`${ANSI.y}→${ANSI.x} ${p}: adopting what Claude wrote into profiles/${p}/settings.json: ${set.adopted.join(", ")}`);
    if (set.orphan) say(`${ANSI.r}!${ANSI.x} ${p}/settings.json was a file with no record of generating it: kept aside as ${shortHome(set.orphan)}`);
    if (set.migrated) say(`${ANSI.y}→${ANSI.x} ${p}/settings.json: from a link to shared/ to a generated file`);
    else if (set.wrote) say(`${ANSI.g}+${ANSI.x} ${p}/settings.json regenerated`);
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
  // Each profile gets its launcher name pointed at the one wrapper, which identifies the profile
  // from the name it is invoked as. A new profile needs no new file in bin/.
  for (const l of await launchers()) {
    await ensureSymlink(`${REPO}/bin/claude`, `${BIN}/${l.command}`, `~/.local/bin/${l.command}`);
  }
  await ensureSymlink(`${REPO}/shared/hooks/claude-distiller`, `${BIN}/claude-distiller`, "~/.local/bin/claude-distiller");
  await ensureSymlink(`${REPO}/shared/tools/stignore-gen/stignore-gen.ts`, `${BIN}/stignore-gen`, "~/.local/bin/stignore-gen");
  if (await lstat(`${BIN}/claude-multi-finalize`)) await removeLink(`${BIN}/claude-multi-finalize`, "superato da doctor");
  await ensureDir(LIB);
  // The update GUI became the desktop app (bin/claude-multi-app finds its code through the repo).
  for (const old of [`${LIB}/claude-update-gui`, `${BIN}/claude-update-gui`]) if ((await lstat(old))?.isSymlink) await removeLink(old, "replaced by claude-multi-app");

  // 5b. the repository's git hooks (pre-commit: secret guard + type check)
  const hooks = (await run("git", ["-C", REPO, "config", "--get", "core.hooksPath"])).out;
  if (hooks !== ".githooks") { say(`${ANSI.g}+${ANSI.x} git core.hooksPath → .githooks (pre-commit)`); if (!DRY) await run("git", ["-C", REPO, "config", "core.hooksPath", ".githooks"]); }

  // 5c. stignore-gen's git template: a repository cloned inside a Syncthing folder gets its .stignore block
  // from the post-checkout hook before Syncthing picks its files up (the timer of step 8 is the safety net).
  if (await lstat(SYNCTHING_CONFIG)) {
    const tpl = (await run("git", ["config", "--global", "--get", "init.templateDir"])).out;
    if (tpl !== STIGNORE_GEN_TEMPLATE) { say(`${ANSI.g}+${ANSI.x} git init.templateDir → stignore-gen template${tpl ? ` (was ${tpl})` : ""}`); if (!DRY) await run("git", ["config", "--global", "init.templateDir", STIGNORE_GEN_TEMPLATE]); }
  }

  // 6. stub ~/.claude (500: stat → ENOENT sui settings, nessun "Settings Error")
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) { say(`${ANSI.g}+${ANSI.x} stub ~/.claude (500)`); if (!DRY) { await Deno.mkdir(`${HOME}/.claude`); await Deno.chmod(`${HOME}/.claude`, 0o500); } }
  else if (stub.isDirectory && mode(stub) !== "500") { say(`${ANSI.y}→${ANSI.x} chmod 500 ~/.claude`); if (!DRY) await Deno.chmod(`${HOME}/.claude`, 0o500); }

  // 7. ~/.zshrc
  const zp = `${HOME}/.zshrc`; const zsh = await readText(zp);
  if (zsh !== null) {
    const block = await zshBlock();
    const re = new RegExp(`${ZSH_BEGIN.replace(/[()]/g, "\\$&")}[\\s\\S]*?${ZSH_END}`);
    const next = re.test(zsh) ? zsh.replace(re, block) : `${zsh.trimEnd()}\n\n${block}\n`;
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
      // The desktop app sits in the tray from login (it exits by itself where there is no tray).
      if (m.graphical) wantEnabled.push("claude-multi-app.service");
      // Keeps the git repositories inside Syncthing folders out of Syncthing: only where Syncthing runs.
      if (await lstat(SYNCTHING_CONFIG)) wantEnabled.push("stignore-gen.timer");
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
    for (const d of await listDir(`${REPO}/desktop`)) if (d.endsWith(".desktop")) await ensureRendered(`${REPO}/desktop/${d}`, `${apps}/${d}`);
    // a copy install wrote itself, of a file the repository no longer has
    if (await lstat(`${apps}/claude-update-gui.desktop`)) await removeLink(`${apps}/claude-update-gui.desktop`, "replaced by claude-multi.desktop");
    await writeDesktopEntries(apps);
    for (const s of await listDir(`${REPO}/desktop/icons`)) {
      for (const f of await listDir(`${REPO}/desktop/icons/${s}`)) {
        await ensureCopy(`${REPO}/desktop/icons/${s}/${f}`, `${HOME}/.local/share/icons/hicolor/${s}/apps/${f}`);
      }
    }
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
  // The diagnosis is printed, but it is not this command's verdict: install reports whether it
  // materialised the runtime, not whether the machine is healthy. Returning the doctor's code made
  // `claude-multi install && <next step>` skip the next step exactly when the doctor was
  // complaining about something that step would have fixed — a missing Desktop variant, say.
  // `claude-multi doctor` is the command whose exit code means "healthy".
  const failed = printDoctor(await doctor());
  if (failed) {
    console.log(`  ${ANSI.d}install finished; the checks above are a diagnosis, not a failure of this command.${ANSI.x}`);
    console.log(`  ${ANSI.d}Run their fixes, then \`claude-multi doctor\` to confirm.${ANSI.x}\n`);
  }
  return 0;
}
