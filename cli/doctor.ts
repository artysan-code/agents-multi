// doctor.ts — every invariant of the setup as a check with a verdict and a fix.
// The README describes, the doctor verifies. New invariants belong here, not in prose.

import { AGENTS_SKILLS, BIN, type Check, has, HOME, KINDS, launchers, LIB, ZSH_BEGIN, ZSH_END, zshBlock, listDir, loadManifest, lstat, machine, mode, ownItems, profileInfo, profileNames, readJson, readlink, readText, REPO, repoState, run, RUNTIME, runtimeProfiles, sharedInventory, shortHome, stat, type Status } from "./lib.ts";
import { settingsState } from "./settings.ts";
import { health, legacyStatePresent, plan } from "./mcp.ts";
import { collect, doctorChecks } from "./budget.ts";
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
  const lock = await stat(`${HOME}/.cache/claude-update/update.lock`);
  if (lock) {
    const age = (Date.now() - (lock.mtime?.getTime() ?? 0)) / 60000;
    if (age > 30) add("update.lock", "warn", `claude-update lock is ${Math.round(age)} min old`, "rm ~/.cache/claude-update/update.lock if no update is running");
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
  if (await legacyStatePresent()) add("mcp.legacy", "warn", "shared/mcp/.sync-state.json is a leftover of the old sync script", `rm ${REPO}/shared/mcp/.sync-state.json`);

  // --- updates
  const upd = await readJson<{ cli: { outdated: boolean; latest: string }; desktop: { outdated: boolean; latest: string } }>(`${HOME}/.cache/claude-update/check.json`);
  // the cache can be stale right after an update: it only counts when the remote version differs
  if (upd?.cli?.outdated && upd.cli.latest !== m.cliVersion) add("update.cli", "warn", `Claude Code ${upd.cli.latest} available`, "claude-multi update --cli");
  if (upd?.desktop?.outdated && upd.desktop.latest !== m.desktopVersion) add("update.desktop", "warn", `Claude Desktop ${upd.desktop.latest} available`, "claude-multi update --desktop");
  if (!upd) add("update.check", "warn", "no update check cached", "claude-multi update --check");
  else {
    const ageH = (Date.now() - ((await stat(`${HOME}/.cache/claude-update/check.json`))?.mtime?.getTime() ?? 0)) / 36e5;
    if (ageH > 24) add("update.check", "warn", `update check is ${Math.round(ageH)} h old (timer stopped?)`, "claude-multi update --check");
  }

  // --- Claude Desktop
  if (m.desktopVersion) {
    // Desktop variants are built per profile; only profiles whose manifest names a dedicated
    // directory get one, so a machine with a single profile is not told anything is missing.
    for (const p of declared) {
      const manifest = await loadManifest(p);
      if (!manifest.desktopDir || manifest.desktopDir.endsWith("/Claude")) continue;
      const variant = `claude-desktop-${p}`;
      const bin = await lstat(`${LIB}/${variant}/${variant}`);
      const asar = await lstat(`${LIB}/${variant}/resources/app.asar`);
      const sysAsar = await lstat("/usr/lib/claude-desktop/resources/app.asar");
      if (!bin || !asar) add(`desktop.${p}`, "fail", `Claude Desktop variant for ${p} is missing`, `claude-desktop-rebuild ${p}`);
      else if (sysAsar?.mtime && asar.mtime && sysAsar.mtime > asar.mtime) add(`desktop.${p}`, "fail", `the ${p} variant is older than the system app`, `claude-desktop-rebuild ${p}`);
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
    if ((await readlink(`${LIB}/claude-update-gui`)) !== `${REPO}/lib/claude-update-gui`) add("desktop.gui", "fail", "~/.local/lib/claude-update-gui does not point at the repository", "claude-multi install");
    if (m.systemd && m.graphical) {
      const t = await run("systemctl", ["--user", "is-enabled", "claude-update-check.timer"]);
      if (t.out !== "enabled") add("desktop.timer", "warn", `claude-update-check.timer: ${t.out || "not installed"}`, "claude-multi install");
    }
    if (!(await lstat(`${REPO}/pkg/claude-desktop/anthropic-apt.asc`))) add("desktop.apt-key", "warn", "the Anthropic apt key is not in the repository: the InRelease signature cannot be verified", "fetch the key into pkg/claude-desktop/anthropic-apt.asc");
    else if (!(await has("gpgv"))) add("desktop.apt-key", "warn", "gpgv is missing: the apt repository signature is not verified", "install gnupg");
    else add("desktop.apt-key", "ok", "Anthropic apt repository: key pinned, InRelease verified on every update");
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

  // --- budget: what is actually billed, and whether the reading is fresh enough for alerts to work
  try {
    const b = await collect({ ingest: false });
    for (const x of doctorChecks(b.profiles.map((p) => p.snap), b.cfg, b.alerts)) c.push(x);
  } catch (e) { add("budget", "warn", `budget could not be evaluated: ${(e as Error).message}`, "claude-multi budget"); }
  return c;
}
