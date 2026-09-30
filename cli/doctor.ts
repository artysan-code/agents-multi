// doctor.ts — every invariant of the setup as a check with a verdict and a fix.
// The README describes, the doctor verifies. New invariants belong here, not in prose.

import { AGENTS_SKILLS, BIN, type Check, has, HOME, KINDS, launchers, LIB, ZSH_BEGIN, ZSH_END, zshBlock, listDir, loadManifest, lstat, machine, mode, ownItems, profileInfo, profileNames, readJson, readlink, readText, REPO, repoState, run, RUNTIME, runtimeProfiles, sharedInventory, shortHome, stat, STATE, STIGNORE_GEN_TEMPLATE, SYNCTHING_CONFIG, type Status, updateLog } from "./lib.ts";
import { settingsState } from "./settings.ts";
import { ACCOUNTS, health, legacyStatePresent, plan } from "./mcp.ts";
import { loadAccounts } from "../shared/mcp/lib/accounts.ts";
import { keyMatches, listSecrets, loadKey, vaultDir } from "../shared/mcp/lib/vault.ts";
import { legacyFilesPresent } from "./vault.ts";
import { PORT } from "./serve.ts";

export async function doctor(): Promise<Check[]> {
  const c: Check[] = [];
  const add = (id: string, status: Status, msg: string, fix?: string) => c.push({ id, status, msg, fix });
  const m = await machine();
  const repo = await repoState();

  // --- repository
  if (!repo.isRepo) add("repo", "fail", `${REPO} is not a git repository`, `git clone <your fork> ${shortHome(REPO)}`);
  else {
    if (!repo.upstream) add("repo.upstream", "warn", `branch ${repo.branch} has no upstream: sync is off`, `git -C ${shortHome(REPO)} push -u origin ${repo.branch}`);
    else if (repo.behind && repo.ahead) add("repo.sync", "fail", `repository diverged: ↓${repo.behind} ↑${repo.ahead}`, `git -C ${shortHome(REPO)} pull --rebase (by hand)`);
    else if (repo.behind) add("repo.sync", "warn", `config is ${repo.behind} commits behind`, "claude-multi sync");
    else if (repo.ahead) add("repo.sync", "warn", `${repo.ahead} local commits not pushed`, `git -C ${shortHome(REPO)} push`);
    else add("repo.sync", "ok", `in sync with ${repo.upstream} (${repo.head})`);
    if (repo.dirty) add("repo.dirty", "warn", `${repo.dirty} uncommitted files: ${repo.dirtyFiles.slice(0, 3).map((f) => f.trim()).join(", ")}${repo.dirty > 3 ? "…" : ""}`, `git -C ${shortHome(REPO)} status`);
  }

  if (repo.isRepo && (await run("git", ["-C", REPO, "config", "--get", "core.hooksPath"])).out !== ".githooks") {
    add("repo.hooks", "warn", "repository pre-commit is not active (secret guard + type check)", "claude-multi install");
  }

  // --- shared: broken symlinks, skills installed but not mounted
  const inv = await sharedInventory();
  for (const k of KINDS) {
    const broken = Object.entries(inv[k]).filter(([, v]) => v.broken).map(([n]) => n);
    if (broken.length) add(`shared.${k}.broken`, "fail", `shared/${k}: ${broken.length} broken entries (${broken.slice(0, 4).join(", ")}${broken.length > 4 ? "…" : ""})`, "claude-multi install, or remove the entry");
  }
  const unlinked = inv.agentsSkills.filter((s) => !(s in inv.skills));
  if (unlinked.length) add("shared.skills.unlinked", "warn", `skills in ~/.agents/skills are not mounted: ${unlinked.join(", ")}`, "claude-multi install, then commit");
  if (!Object.values(inv.skills).some((v) => v.broken)) {
    add("shared.skills", "ok", `shared: ${Object.keys(inv.skills).length} skills · ${Object.keys(inv.agents).length} agents · ${Object.keys(inv.commands).length} commands · ${inv.hooks.length} hooks · ${inv.rules.length} rules`);
  }

  // --- runtime shared → repo
  const sharedLink = await readlink(`${RUNTIME}/shared`);
  if (sharedLink === `${REPO}/shared`) add("runtime.shared", "ok", "~/.claude-multi/shared → repository");
  else if (await lstat(`${RUNTIME}/shared`)) add("runtime.shared", "fail", `~/.claude-multi/shared does not point at the repository (${sharedLink ?? "real directory"})`, "claude-multi install");
  else add("runtime.shared", "fail", "~/.claude-multi/shared is missing", "claude-multi install");

  // --- profiles: base symlinks, manifest, credentials, leftovers
  const declared = await profileNames();
  // A skill a profile owns must not appear in another profile: that is how client work leaks into a
  // personal session. Derived from the manifests, so it holds for any profile you add.
  const ownedElsewhere = new Map<string, string>();
  for (const p of declared) for (const s of await ownItems(p, "skills")) ownedElsewhere.set(s, p);

  for (const p of declared) {
    const info = await profileInfo(p);
    if (!info.exists) { add(`profile.${p}`, "fail", `profile ${p} is not materialised`, "claude-multi install"); continue; }
    if (info.claudeMd !== `${REPO}/profiles/${p}/CLAUDE.md`) add(`profile.${p}.claudemd`, "fail", `${p}/CLAUDE.md does not point at the repository`, "claude-multi install");
    const set = await settingsState(p);
    const list = (xs: string[]) => xs.slice(0, 4).join(", ") + (xs.length > 4 ? ` +${xs.length - 4}` : "");
    if (set.kind === "symlink" || set.kind === "missing") add(`profile.${p}.settings`, "fail", `${p}/settings.json is ${set.kind === "symlink" ? "still a link to shared/: it is generated now" : "missing"}`, "claude-multi install");
    else if (set.kind === "local-writes") add(`profile.${p}.settings`, "warn", `${p}: Claude changed settings.json (${list(set.changed)}), not yet adopted into profiles/${p}/settings.json`, "claude-multi settings (or just launch Claude)");
    else if (set.kind === "stale") add(`profile.${p}.settings`, "warn", `${p}/settings.json is behind its sources (${list(set.changed)})`, "claude-multi settings (or just launch Claude)");
    if (info.hooks !== "../shared/hooks") add(`profile.${p}.hooks`, "fail", `${p}/hooks → ${info.hooks ?? "not a symlink"}`, "claude-multi install");

    for (const k of KINDS) {
      const spec = info.manifest[k]; const own = await ownItems(p, k);
      // Claude Code writes into these directories (the account skill sync, agents and commands it
      // creates): a symlink to shared/ would hand it the repository. They are real directories now.
      if (info.kindLinks[k]) { add(`profile.${p}.${k}`, "fail", `${p}/${k} is a symlink (→ ${info.kindLinks[k]}): it must be a real directory, Claude Code writes here`, "claude-multi install"); continue; }
      // "all" means every valid item of the kind: a broken entry in shared/ is not mounted anywhere,
      // so it is not "missing" from a profile either — it is reported once, against shared.
      const expected = new Set([...(spec === "all" ? Object.keys(inv[k]).filter((n) => !inv[k][n].broken) : spec), ...own.map((n) => n.replace(/\.md$/, ""))]);
      const actual = new Set(Object.keys(info.mounted[k]));
      const missing = [...expected].filter((n) => !actual.has(n)); const extra = [...actual].filter((n) => !expected.has(n));
      const broken = Object.entries(info.mounted[k]).filter(([, v]) => v.broken).map(([n]) => n);
      if (missing.length) add(`profile.${p}.${k}.missing`, "fail", `${p}/${k}: missing ${missing.join(", ")}`, "claude-multi install");
      if (extra.length) add(`profile.${p}.${k}.extra`, "warn", `${p}/${k}: mounted outside the manifest: ${extra.join(", ")}`, `add them to profiles/${p}/profile.json, or remove the links`);
      if (broken.length) add(`profile.${p}.${k}.broken`, "fail", `${p}/${k}: broken links: ${broken.join(", ")}`, "claude-multi install");
    }

    const leak = Object.keys(info.mounted.skills).filter((s) => (ownedElsewhere.get(s) ?? p) !== p);
    if (leak.length) {
      add(`profile.${p}.leak`, "fail", `${p} mounts skills owned by another profile: ${leak.map((s) => `${s} (${ownedElsewhere.get(s)})`).join(", ")}`, "claude-multi install");
    }

    if (info.brokenPlugins.length) add(`profile.${p}.plugins`, "fail", `${p}: installed plugins whose files are gone (they fail to load): ${info.brokenPlugins.join(", ")}`, "console → Plugins: Remove, then install again (or claude plugin install <id> in that profile)");
    if (info.stalePlugins.length) add(`profile.${p}.plugins.stale`, "warn", `${p}: plugin records for projects that no longer exist (they load nowhere): ${info.stalePlugins.map((s) => `${s.id} (${s.scope}, ${shortHome(s.project)})`).join(", ")}`, `claude plugin uninstall <id> --scope <scope> reaches them only from inside the project: drop those records from ${shortHome(info.dir)}/plugins/installed_plugins.json (keep a copy)`);
    const cmd = info.manifest.command;
    if (!info.credentials.present) add(`profile.${p}.login`, "warn", `${p}: no stored credentials, sign-in needed`, `${cmd ?? "claude"} → /login`);
    else if (info.credentials.mode !== "600") add(`profile.${p}.creds`, "fail", `${p}/.credentials.json mode ${info.credentials.mode}`, `chmod 600 ${info.dir}/.credentials.json`);
    const junk = (await listDir(info.dir)).filter((f) => /\.(bak|backup|pre-|tmp\.)/.test(f) && /credentials|claude\.json|settings/.test(f));
    if (junk.length) add(`profile.${p}.junk`, "fail", `backups holding tokens or an account in the profile: ${junk.join(", ")}`, `rm ${junk.map((f) => `${info.dir}/${f}`).join(" ")}`);
    add(`profile.${p}`, "ok", `${p}: ${info.account ?? "no account"} · ${Object.keys(info.mounted.skills).length} skills · mcp cli ${info.mcp.length}${m.desktopVersion ? ` / desktop ${info.mcpDesktop.length}` : ""} · ${info.plugins.length} plugins${info.manifest.disableAccountMcp ? ` · account MCP off (connectors + ${info.synced.length} synced plugin${info.synced.length === 1 ? "" : "s"})` : ""}`);
  }

  // A runtime directory the repository no longer declares keeps its credentials and transcripts
  // around while nothing manages it any more.
  const orphans = (await runtimeProfiles()).filter((p) => !declared.includes(p));
  if (orphans.length) add("profile.orphan", "warn", `runtime directories with no profile in the repository: ${orphans.join(", ")}`, `add profiles/<name>/profile.json, or remove ${orphans.map((p) => `${shortHome(RUNTIME)}/${p}`).join(" ")}`);

  // --- binaries and wrappers
  const claudeLink = await readlink(`${BIN}/claude`);
  if (claudeLink === `${REPO}/bin/claude`) add("bin.claude", "ok", "~/.local/bin/claude → the repository's launcher");
  else if (claudeLink?.includes("claude/versions/")) add("bin.claude", "fail", "~/.local/bin/claude is the native updater's symlink: `claude` would start on the wrong profile", "claude-multi install");
  else add("bin.claude", "fail", `~/.local/bin/claude → ${claudeLink ?? "a real file, or missing"}`, "claude-multi install");
  // Every wrapper the repository ships, plus one launcher per profile pointed at bin/claude —
  // both lists come from what is there, so a new profile or script needs no edit here.
  for (const b of await listDir(`${REPO}/bin`)) {
    if (b === "lib" || b === "claude") continue;
    if ((await readlink(`${BIN}/${b}`)) !== `${REPO}/bin/${b}`) add(`bin.${b}`, "fail", `~/.local/bin/${b} does not point at the repository`, "claude-multi install");
  }
  const missingLaunchers = [];
  for (const l of await launchers()) {
    if (l.command === "claude") continue; // covered by bin.claude above
    if ((await readlink(`${BIN}/${l.command}`)) !== `${REPO}/bin/claude`) missingLaunchers.push(`${l.command} (${l.profile})`);
  }
  if (missingLaunchers.length) add("bin.launchers", "fail", `launchers not pointing at the repository: ${missingLaunchers.join(", ")}`, "claude-multi install");
  else add("bin.launchers", "ok", `launchers: ${(await launchers()).map((l) => `${l.command} (${l.profile})`).join(" · ")}`);
  if (await lstat(`${BIN}/claude-multi-finalize`)) add("bin.finalize", "warn", "claude-multi-finalize is superseded by `claude-multi doctor`", `rm ${BIN}/claude-multi-finalize`);
  if (!m.cliVersion) add("bin.claude-bin", "fail", "claude-bin resolves to no version", "claude-multi update --cli");
  else {
    add("bin.claude-bin", m.cliVersions.length > 2 ? "warn" : "ok", `Claude Code ${m.cliVersion}${m.cliVersions.length > 1 ? ` (+${m.cliVersions.length - 1} cached, rollback available)` : ""}`, m.cliVersions.length > 2 ? "claude-multi update --cli (prunes past N-1)" : undefined);
  }
  // The lock file outlives every run (flock, not presence, is the lock): it only means something
  // when a process still holds it, and holds it for longer than any update takes.
  const lockPath = `${HOME}/.cache/claude-update/update.lock`;
  const lock = await stat(lockPath);
  if (lock && (await run("flock", ["-n", lockPath, "true"])).code !== 0) {
    const age = (Date.now() - (lock.mtime?.getTime() ?? 0)) / 60000;
    if (age > 30) add("update.lock", "warn", `an update has held its lock for ${Math.round(age)} min`, "pgrep -af claude-update — kill it if it hangs");
  }
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) add("stub", "warn", "~/.claude is missing (the safety stub)", "claude-multi install");
  else if (!stub.isDirectory) add("stub", "fail", "~/.claude is not a directory", "rm ~/.claude && claude-multi install");
  else if (mode(stub) !== "500") add("stub", "fail", `~/.claude mode ${mode(stub)} (expected 500)`, "chmod 500 ~/.claude");
  else add("stub", "ok", "~/.claude stub is read-only (500)");

  // --- shell integration
  const zsh = await readText(`${HOME}/.zshrc`) ?? "";
  // Compared against the block the manifests produce, not just probed for a marker: that is what
  // catches a profile added or renamed since the last install, whose alias is still the old one.
  const wantBlock = await zshBlock();
  const haveBlock = zsh.match(new RegExp(`${ZSH_BEGIN.replace(/[()]/g, "\\$&")}[\\s\\S]*?${ZSH_END}`))?.[0];
  if (!haveBlock) add("zshrc", "warn", "no claude-multi block in ~/.zshrc", "claude-multi install");
  else if (haveBlock !== wantBlock) add("zshrc", "warn", "the claude-multi block in ~/.zshrc no longer matches the manifests", "claude-multi install");
  else add("zshrc", "ok", "~/.zshrc block is current");

  // --- Syncthing: the claude-multi folder must not exist any more (config travels through git)
  if (await lstat(`${RUNTIME}/.stfolder`)) add("syncthing", "warn", "~/.claude-multi is still a Syncthing folder", "remove the claude-multi folder from Syncthing");

  // --- Syncthing: stignore-gen keeps the git repositories out (post-checkout hook on clone + timer)
  if (await lstat(SYNCTHING_CONFIG)) {
    const tpl = (await run("git", ["config", "--global", "--get", "init.templateDir"])).out;
    const timer = m.systemd ? (await run("systemctl", ["--user", "is-enabled", "stignore-gen.timer"])).out : "enabled";
    if (tpl !== STIGNORE_GEN_TEMPLATE) add("stignore-gen", "warn", `git init.templateDir is ${tpl || "unset"}: a clone inside a Syncthing folder waits for the timer`, "claude-multi install");
    else if (timer !== "enabled") add("stignore-gen", "warn", `stignore-gen.timer: ${timer || "not installed"}`, "claude-multi install");
    else add("stignore-gen", "ok", "stignore-gen: git repositories kept out of Syncthing (hook on clone, timer every 15 min)");
  }

  // --- console: serving itself is the point of the unit
  if (m.systemd) {
    const en = (await run("systemctl", ["--user", "is-enabled", "claude-multi-console.service"])).out;
    const act = (await run("systemctl", ["--user", "is-active", "claude-multi-console.service"])).out;
    if (en !== "enabled") add("console.unit", "warn", `claude-multi-console.service: ${en || "not installed"}`, "claude-multi install");
    else if (act !== "active") add("console.unit", "warn", `claude-multi-console.service is ${act}`, "systemctl --user restart claude-multi-console.service");
    else add("console.unit", "ok", `console on http://127.0.0.1:${PORT} (systemd user unit)`);
  }

  // --- MCP: registry against the surfaces, plus dependencies
  try {
    const { changes } = await plan();
    if (!changes.length) add("mcp.sync", "ok", "MCP registry applied on CLI and Desktop");
    else add("mcp.sync", "warn", `MCP registry out of sync: ${changes.length} changes (${[...new Set(changes.map((x) => x.target.managedKey))].join(", ")})`, "claude-multi mcp sync (with Claude closed)");
  } catch (e) { add("mcp.sync", "fail", `MCP registry: ${(e as Error).message}`); }
  for (const h of await health()) c.push(h);

  // --- the secret vault and the accounts that need it
  const accounts = loadAccounts(ACCOUNTS);
  if (accounts.length) {
    const key = await loadKey().catch((e) => e as Error);
    const initialised = !!(await readText(`${vaultDir()}/key-check.json`));
    if (key instanceof Error) {
      add("vault", "fail", initialised ? "this machine is not paired with the secret vault: account-backed MCP servers cannot work" : "no secret vault yet: account-backed MCP servers cannot work", initialised ? "claude-multi vault pair (in a terminal, with the recovery code)" : "claude-multi vault init (in a terminal)");
    } else if (!(await keyMatches(key))) {
      add("vault", "fail", "this machine's vault key does not open the vault", "claude-multi vault pair (with the right recovery code)");
    } else {
      const l = await listSecrets(key);
      const missing = accounts.filter((a) => !l.entries.some((e) => e.service === a.service && e.account === a.name));
      if (missing.length) add("vault.secrets", "warn", `no secret for ${missing.map((a) => `${a.service}/${a.name}`).join(", ")}`, "console › Connections, or claude-multi vault set <service> <account>");
      if (l.conflicts) add("vault.conflicts", "warn", `${l.conflicts} Syncthing conflict copies in the vault`, `ls ${vaultDir()}/secrets/*sync-conflict*`);
      if (l.unreadable) add("vault.unreadable", "fail", `${l.unreadable} vault entries this key cannot open`, "claude-multi vault status");
      if (!missing.length && !l.conflicts && !l.unreadable) add("vault", "ok", `secret vault: ${accounts.length} accounts, every secret here`);
      if (accounts.some((a) => a.service === "google") && !l.entries.some((e) => e.service === "google-oauth" && e.account === "client"))
        add("google.client", "warn", "Google accounts are listed but the OAuth client is not in the vault: none of them can connect", "console › Connections › Import the JSON, or claude-multi google client <file.json>");
    }
    // The key sits in the keyring, readable by any process of this user — Claude's Bash included.
    // These deny rules are what keeps a session from reading it, or the entries it opens.
    const deny = (await readJson<{ permissions?: { deny?: string[] } }>(`${REPO}/shared/settings.json`))?.permissions?.deny ?? [];
    const needed = ["Bash(secret-tool:*)", "Bash(kwallet-query:*)", "Bash(claude-multi vault recovery-code:*)", "Read(~/vault/claude-multi/**)", "Edit(~/vault/claude-multi/**)"];
    const absent = needed.filter((r) => !deny.includes(r));
    if (absent.length) add("vault.deny", "fail", `Claude sessions could read the vault key or entries: shared deny lacks ${absent.join(", ")}`, "console › System › Permissions › Denied");
    const legacy = await legacyFilesPresent();
    if (legacy.length) add("vault.legacy", "warn", `secrets still outside the vault: ${legacy.map(shortHome).join(", ")}`, "claude-multi vault import-legacy (imports, checks, then removes them)");
  }
  if (await legacyStatePresent()) add("mcp.legacy", "warn", "shared/mcp/.sync-state.json is a leftover of the old sync script", `rm ${REPO}/shared/mcp/.sync-state.json`);

  // --- updates: they install themselves (claude-update --auto, from the timer), so a newer version
  // is not news. What is: the last attempt for a component failed, or verification refused one.
  const upd = await readJson<unknown>(`${HOME}/.cache/claude-update/check.json`);
  const log = await updateLog(50);
  for (const comp of ["cli", "desktop"]) {
    const last = log.find((e) => e.component === comp && e.event !== "waiting");
    const name = comp === "cli" ? "Claude Code" : "Claude Desktop";
    if (last?.event === "verify-failed") add(`update.${comp}`, "fail", `${name}: the last update failed verification (${last.detail}) — nothing was installed`, "claude-multi update --auto");
    else if (last?.event === "failed") add(`update.${comp}`, "warn", `${name}: the last update failed (${last.detail || "see the journal"})`, "claude-multi update --auto");
  }
  if (!upd) add("update.check", "warn", "no update check cached", "claude-multi update --check");
  else {
    const ageH = (Date.now() - ((await stat(`${HOME}/.cache/claude-update/check.json`))?.mtime?.getTime() ?? 0)) / 36e5;
    if (ageH > 24) add("update.check", "warn", `update check is ${Math.round(ageH)} h old (timer stopped?)`, "claude-multi update --check");
  }

  // --- Claude Desktop: in user space since 2026-09-30 (bin/claude-desktop-update)
  if (m.desktopSystem) {
    add("desktop.userspace", "warn", `Claude Desktop ${m.desktopSystem} is still the system package: it cannot update itself`, "claude-desktop-migrate (in a terminal, with every Claude Desktop closed)");
  } else if (m.desktopVersion) {
    const shims = await run("pacman", ["-Q", "claude-desktop-shims"]);
    if (shims.code !== 0) add("desktop.shims", "warn", "claude-desktop-shims is not installed: the VM mode misses virtiofsd/OVMF and the runtime libraries are untracked", "claude-desktop-migrate");
  }
  if (m.desktopVersion) {
    // Desktop variants are built per profile; only profiles whose manifest names a dedicated
    // directory get one, so a machine with a single profile is not told anything is missing.
    for (const p of declared) {
      const manifest = await loadManifest(p);
      if (!manifest.desktopDir || manifest.desktopDir.endsWith("/Claude")) continue;
      const variant = `claude-desktop-${p}`;
      const bin = await lstat(`${LIB}/${variant}/${variant}`);
      const asar = await lstat(`${LIB}/${variant}/resources/app.asar`);
      // the variant is built from the version in use; a switch rebuilds it, so older means a failed rebuild
      const srcAsar = await stat(m.desktopSystem ? "/usr/lib/claude-desktop/resources/app.asar" : `${LIB}/claude-desktop/current/resources/app.asar`);
      if (!bin || !asar) add(`desktop.${p}`, "fail", `Claude Desktop variant for ${p} is missing`, `claude-desktop-rebuild ${p}`);
      else if (srcAsar?.mtime && asar.mtime && srcAsar.mtime > asar.mtime) add(`desktop.${p}`, "fail", `the ${p} variant is older than the Claude Desktop in use`, `claude-desktop-rebuild ${p}`);
      else add(`desktop.${p}`, "ok", `Claude Desktop ${m.desktopVersion} + ${p} variant in step`);
    }
    for (const d of await listDir(`${REPO}/desktop`)) {
      if (!d.endsWith(".desktop")) continue;
      const source = await readText(`${REPO}/desktop/${d}`) ?? "";
      const installed = await readText(`${HOME}/.local/share/applications/${d}`);
      if (!installed) { add(`desktop.entry.${d}`, "fail", `${d} is missing`, "claude-multi install"); continue; }
      // Only launchers go through claude-launch; other entries (the update GUI) legitimately do
      // not, so the requirement is read off the repository's own copy rather than assumed.
      if (source.includes("claude-launch") && !installed.includes("claude-launch")) {
        add(`desktop.entry.${d}`, "fail", `${d} does not go through claude-launch`, "claude-multi install");
      }
    }
    // The desktop app (tray and console window). WebEngine is only an optional
    // dependency of pyside6 on Arch: present here by accident of KDE, missing on a bare install.
    const qt = await run("pacman", ["-Q", "pyside6", "qt6-webengine"]);
    const missing = ["pyside6", "qt6-webengine"].filter((p) => !qt.out.split("\n").some((l) => l.startsWith(`${p} `)));
    if (missing.length) add("app.deps", "fail", `the desktop app needs ${missing.join(" and ")}`, `sudo pacman -S --needed ${missing.join(" ")}`);
    if (m.systemd && m.graphical) {
      const u = await run("systemctl", ["--user", "is-enabled", "claude-multi-app.service"]);
      if (u.out !== "enabled") add("app.unit", "warn", `claude-multi-app.service: ${u.out || "not installed"} — no tray icon at login`, "claude-multi install");
    }
    const app = await readJson<{ tray?: boolean }>(`${STATE}/app.json`);
    if (app?.tray === false) add("app.tray", "warn", "the desktop app found no system tray in this session: it runs without its icon", "GNOME: enable the AppIndicator extension, then systemctl --user restart claude-multi-app");
    if (!missing.length && app?.tray !== false) add("app", "ok", "desktop app: pyside6 + qt6-webengine" + (app?.tray ? ", tray available" : ""));
    if (m.systemd && m.graphical) {
      const t = await run("systemctl", ["--user", "is-enabled", "claude-update-check.timer"]);
      if (t.out !== "enabled") add("desktop.timer", "warn", `claude-update-check.timer: ${t.out || "not installed"}`, "claude-multi install");
      const tt = await run("systemctl", ["--user", "is-enabled", "claude-tasks.timer"]);
      if (tt.out !== "enabled") add("tasks.timer", "warn", `claude-tasks.timer: ${tt.out || "not installed"} — no task reminders on this machine`, "claude-multi install");
    }
    if (!(await lstat(`${REPO}/pkg/claude-desktop/anthropic-apt.asc`))) add("desktop.apt-key", "warn", "the Anthropic apt key is not in the repository: the InRelease signature cannot be verified", "fetch the key into pkg/claude-desktop/anthropic-apt.asc");
    else if (!(await has("gpgv"))) add("desktop.apt-key", "warn", "gpgv is missing: the apt repository signature is not verified", "install gnupg");
    else add("desktop.apt-key", "ok", "Anthropic apt repository: key pinned, every update verified (InRelease → Packages → .deb)");
    const handler = await readText(`${HOME}/.local/share/applications/claude-code-url-handler.desktop`);
    if (handler && !handler.includes("claude-bin")) add("desktop.urlhandler", "fail", "the claude-cli:// url handler does not point at claude-bin", "claude-multi install");
  }

  // --- local embedding backend for the wiki MCP server (optional on any given machine)
  if (await lstat(`${HOME}/.local/opt/llama-vulkan/bin/llama-server`) && m.systemd) {
    for (const u of ["llama-embed.service", "llama-embed-shim.service"]) {
      const en = (await run("systemctl", ["--user", "is-enabled", u])).out; const act = (await run("systemctl", ["--user", "is-active", u])).out;
      if (en !== "enabled" || act !== "active") add(`llama.${u}`, "warn", `${u}: ${en}/${act}`, `systemctl --user enable --now ${u}`);
    }
    const gen = (await run("systemctl", ["--user", "is-enabled", "llama-generate.service"])).out;
    if (gen === "enabled") add("llama.generate", "warn", "llama-generate.service is enabled at boot: it should stay on demand (the shim starts it)", "systemctl --user disable llama-generate.service");
    if (!(await readlink(`${HOME}/.config/systemd/user/llama-embed-shim.service`))?.startsWith(REPO)) add("llama.units", "warn", "llama-*.service units are not linked from the repository", "claude-multi install");
  }
  if (!(await lstat(AGENTS_SKILLS))) add("agents.dir", "warn", "~/.agents/skills is missing: external skills are unavailable on this machine", "create it, or sync it from your other machine");
  return c;
}
