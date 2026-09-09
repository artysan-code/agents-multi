// doctor.ts — ogni invariante del setup come check con esito e fix. Il README descrive, il doctor verifica.

import { AGENTS_SKILLS, BIN, type Check, has, HOME, KINDS, LIB, listDir, lstat, machine, mode, ownItems, PROFILES, profileInfo, readJson, readlink, readText, REPO, repoState, run, RUNTIME, sharedInventory, shortHome, stat, type Status } from "./lib.ts";
import { health, legacyStatePresent, plan } from "./mcp.ts";

export async function doctor(): Promise<Check[]> {
  const c: Check[] = [];
  const add = (id: string, status: Status, msg: string, fix?: string) => c.push({ id, status, msg, fix });
  const m = await machine();
  const repo = await repoState();

  // --- repo
  if (!repo.isRepo) add("repo", "fail", `${REPO} non è un repo git`, "git clone ssh://git@git.example.com:2222/owner/claude-multi.git ~/.local/src/claude-multi");
  else {
    if (!repo.upstream) add("repo.upstream", "warn", `branch ${repo.branch} senza upstream: sync disattivo`, `git -C ${shortHome(REPO)} push -u origin ${repo.branch}`);
    else if (repo.behind && repo.ahead) add("repo.sync", "fail", `repo divergente: ↓${repo.behind} ↑${repo.ahead}`, `git -C ${shortHome(REPO)} pull --rebase (a mano)`);
    else if (repo.behind) add("repo.sync", "warn", `config indietro di ${repo.behind} commit`, "claude-multi sync");
    else if (repo.ahead) add("repo.sync", "warn", `${repo.ahead} commit locali non pushati`, `git -C ${shortHome(REPO)} push`);
    else add("repo.sync", "ok", `repo allineato a ${repo.upstream} (${repo.head})`);
    if (repo.dirty) add("repo.dirty", "warn", `${repo.dirty} file modificati non committati: ${repo.dirtyFiles.slice(0, 3).map((f) => f.trim()).join(", ")}${repo.dirty > 3 ? "…" : ""}`, `git -C ${shortHome(REPO)} status`);
  }

  if (repo.isRepo && (await run("git", ["-C", REPO, "config", "--get", "core.hooksPath"])).out !== ".githooks") add("repo.hooks", "warn", "pre-commit del repo non attivo (guard segreti + check)", "claude-multi install");

  // --- condiviso: symlink rotti, skill installate ma non montate
  const inv = await sharedInventory();
  for (const k of KINDS) {
    const broken = Object.entries(inv[k]).filter(([, v]) => v.broken).map(([n]) => n);
    if (broken.length) add(`shared.${k}.broken`, "fail", `shared/${k}: ${broken.length} voci rotte (${broken.slice(0, 4).join(", ")}${broken.length > 4 ? "…" : ""})`, "claude-multi install (ricrea i link a ~/.agents/skills) o rimuovi la voce");
  }
  const unlinked = inv.agentsSkills.filter((s) => !(s in inv.skills));
  if (unlinked.length) add("shared.skills.unlinked", "warn", `skill in ~/.agents/skills non montate: ${unlinked.join(", ")}`, "claude-multi install (le linka in shared/skills) e commit");
  if (!Object.values(inv.skills).some((v) => v.broken)) add("shared.skills", "ok", `shared: ${Object.keys(inv.skills).length} skill · ${Object.keys(inv.agents).length} agenti · ${Object.keys(inv.commands).length} comandi · ${inv.hooks.length} hook · ${inv.rules.length} regole`);

  // --- runtime shared → repo
  const sharedLink = await readlink(`${RUNTIME}/shared`);
  if (sharedLink === `${REPO}/shared`) add("runtime.shared", "ok", "~/.claude-multi/shared → repo");
  else if (await lstat(`${RUNTIME}/shared`)) add("runtime.shared", "fail", `~/.claude-multi/shared non punta al repo (${sharedLink ?? "dir reale"})`, "claude-multi install");
  else add("runtime.shared", "fail", "~/.claude-multi/shared assente", "claude-multi install");

  // --- profili: symlink base, manifest, credenziali, junk
  for (const p of PROFILES) {
    const info = await profileInfo(p);
    if (!info.exists) { add(`profile.${p}`, "fail", `profilo ${p} assente`, "claude-multi install"); continue; }
    if (info.claudeMd !== `${REPO}/profiles/${p}/CLAUDE.md`) add(`profile.${p}.claudemd`, "fail", `${p}/CLAUDE.md non punta al repo`, "claude-multi install");
    if (info.settings !== "../shared/settings.json") add(`profile.${p}.settings`, "fail", `${p}/settings.json → ${info.settings ?? "non symlink"}`, "claude-multi install");
    if (info.hooks !== "../shared/hooks") add(`profile.${p}.hooks`, "fail", `${p}/hooks → ${info.hooks ?? "non symlink"}`, "claude-multi install");
    // manifest
    for (const k of KINDS) {
      const spec = info.manifest[k]; const own = await ownItems(p, k);
      if (spec === "all" && own.length === 0) {
        if (info.kindLinks[k] !== `../shared/${k}`) add(`profile.${p}.${k}`, "fail", `${p}/${k}: manifest "all" ma → ${info.kindLinks[k] ?? "dir reale"}`, "claude-multi install");
        continue;
      }
      if (info.kindLinks[k]) { add(`profile.${p}.${k}`, "fail", `${p}/${k}: manifest selettivo ma è un symlink`, "claude-multi install"); continue; }
      const expected = new Set([...(spec === "all" ? Object.keys(inv[k]) : spec), ...own.map((n) => n.replace(/\.md$/, ""))]);
      const actual = new Set(Object.keys(info.mounted[k]));
      const missing = [...expected].filter((n) => !actual.has(n)); const extra = [...actual].filter((n) => !expected.has(n));
      const broken = Object.entries(info.mounted[k]).filter(([, v]) => v.broken).map(([n]) => n);
      if (missing.length) add(`profile.${p}.${k}.missing`, "fail", `${p}/${k}: mancano ${missing.join(", ")}`, "claude-multi install");
      if (extra.length) add(`profile.${p}.${k}.extra`, "warn", `${p}/${k}: montate fuori manifest: ${extra.join(", ")}`, `aggiungile a profiles/${p}/profile.json o rimuovi i link`);
      if (broken.length) add(`profile.${p}.${k}.broken`, "fail", `${p}/${k}: link rotti: ${broken.join(", ")}`, "claude-multi install");
    }
    if (p === "personal") {
      const leak = Object.keys(info.mounted.skills).filter((s) => s.startsWith("clientapp"));
      if (leak.length) add("profile.personal.leak", "fail", `skill cliente caricate in personal: ${leak.join(", ")}`, "spostale in profiles/work/skills e claude-multi install");
    }
    if (!info.credentials.present) add(`profile.${p}.login`, "warn", `${p}: nessuna credenziale, serve /login`, p === "work" ? "claude-work → /login" : "claude → /login");
    else if (info.credentials.mode !== "600") add(`profile.${p}.creds`, "fail", `${p}/.credentials.json mode ${info.credentials.mode}`, `chmod 600 ${info.dir}/.credentials.json`);
    const junk = (await listDir(info.dir)).filter((f) => /\.(bak|backup|pre-|tmp\.)/.test(f) && /credentials|claude\.json|settings/.test(f));
    if (junk.length) add(`profile.${p}.junk`, "fail", `backup con token/account nel profilo: ${junk.join(", ")}`, `rm ${junk.map((f) => `${info.dir}/${f}`).join(" ")}`);
    add(`profile.${p}`, "ok", `${p}: ${info.account ?? "account ?"} · skill ${Object.keys(info.mounted.skills).length} · mcp cli ${info.mcp.length}${m.desktopVersion ? ` / desktop ${info.mcpDesktop.length}` : ""} · plugin ${info.plugins.length}`);
  }

  // --- binari e wrapper
  const claudeLink = await readlink(`${BIN}/claude`);
  if (claudeLink === `${REPO}/bin/claude`) add("bin.claude", "ok", "~/.local/bin/claude → wrapper personal del repo");
  else if (claudeLink?.includes("claude/versions/")) add("bin.claude", "fail", "~/.local/bin/claude è il symlink dell'updater nativo: `claude` partirebbe col profilo sbagliato", "claude-multi install");
  else add("bin.claude", "fail", `~/.local/bin/claude → ${claudeLink ?? "file reale/assente"}`, "claude-multi install");
  for (const b of ["claude-work", "claude-multi", "claude-launch", "claude-update"]) {
    if ((await readlink(`${BIN}/${b}`)) !== `${REPO}/bin/${b}`) add(`bin.${b}`, "fail", `~/.local/bin/${b} non punta al repo`, "claude-multi install");
  }
  if (await lstat(`${BIN}/claude-multi-finalize`)) add("bin.finalize", "warn", "claude-multi-finalize è superato da `claude-multi doctor`", `rm ${BIN}/claude-multi-finalize`);
  if (!m.cliVersion) add("bin.claude-bin", "fail", "claude-bin non risolve a nessuna versione", "claude-multi update --cli");
  else add("bin.claude-bin", m.cliVersions.length > 2 ? "warn" : "ok", `Claude Code ${m.cliVersion}${m.cliVersions.length > 1 ? ` (+${m.cliVersions.length - 1} in cache, rollback disponibile)` : ""}`, m.cliVersions.length > 2 ? "claude-multi update --cli (pota oltre N-1)" : undefined);
  const lock = await stat(`${HOME}/.cache/claude-update/update.lock`);
  if (lock) { const age = (Date.now() - (lock.mtime?.getTime() ?? 0)) / 60000; if (age > 30) add("update.lock", "warn", `lock di claude-update vecchio di ${Math.round(age)} min`, "rm ~/.cache/claude-update/update.lock se nessun update è in corso"); }
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) add("stub", "warn", "~/.claude assente (stub di sicurezza)", "claude-multi install");
  else if (!stub.isDirectory) add("stub", "fail", "~/.claude non è una directory", "rm ~/.claude && claude-multi install");
  else if (mode(stub) !== "500") add("stub", "fail", `~/.claude mode ${mode(stub)} (atteso 500)`, "chmod 500 ~/.claude");
  else add("stub", "ok", "~/.claude stub read-only (500)");

  // --- zshrc
  const zsh = await readText(`${HOME}/.zshrc`) ?? "";
  if (!zsh.includes("# >>> claude-multi")) add("zshrc", "warn", "blocco claude-multi assente in ~/.zshrc", "claude-multi install");
  else if (!zsh.includes("claude-multi/personal") || zsh.includes("alias claude=")) add("zshrc", "fail", "blocco claude-multi in ~/.zshrc obsoleto", "claude-multi install");
  else add("zshrc", "ok", "blocco ~/.zshrc aggiornato");

  // --- Syncthing: la folder claude-multi non deve più esistere
  if (await lstat(`${RUNTIME}/.stfolder`)) add("syncthing", "warn", "~/.claude-multi è ancora una folder Syncthing", "rimuovi la folder claude-multi da Syncthing (la config viaggia via git)");

  // --- MCP: registry vs superfici, dipendenze
  try {
    const { changes } = await plan();
    if (!changes.length) add("mcp.sync", "ok", "registry MCP applicato su CLI e Desktop");
    else add("mcp.sync", "warn", `registry MCP fuori sync: ${changes.length} modifiche (${[...new Set(changes.map((x) => x.target.managedKey))].join(", ")})`, "claude-multi mcp sync (a Claude chiuso)");
  } catch (e) { add("mcp.sync", "fail", `registry MCP: ${(e as Error).message}`); }
  for (const h of await health()) c.push(h);
  if (await legacyStatePresent()) add("mcp.legacy", "warn", "shared/mcp/.sync-state.json è residuo del vecchio mcp-sync.py", `rm ${REPO}/shared/mcp/.sync-state.json`);

  // --- aggiornamenti
  const upd = await readJson<{ cli: { outdated: boolean; latest: string }; desktop: { outdated: boolean; latest: string } }>(`${HOME}/.cache/claude-update/check.json`);
  // la cache può essere stantia subito dopo un update: conta solo se la versione remota è diversa da quella installata
  if (upd?.cli?.outdated && upd.cli.latest !== m.cliVersion) add("update.cli", "warn", `Claude Code ${upd.cli.latest} disponibile`, "claude-multi update --cli");
  if (upd?.desktop?.outdated && upd.desktop.latest !== m.desktopVersion) add("update.desktop", "warn", `Claude Desktop ${upd.desktop.latest} disponibile`, "claude-multi update --desktop");
  if (!upd) add("update.check", "warn", "nessun check aggiornamenti in cache", "claude-multi update --check");
  else {
    const ageH = (Date.now() - ((await stat(`${HOME}/.cache/claude-update/check.json`))?.mtime?.getTime() ?? 0)) / 36e5;
    if (ageH > 24) add("update.check", "warn", `check aggiornamenti vecchio di ${Math.round(ageH)} h (timer fermo?)`, "claude-multi update --check · systemctl --user status claude-update-check.timer");
  }

  // --- Claude Desktop
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
    if (!(await lstat(`${REPO}/pkg/claude-desktop/anthropic-apt.asc`))) add("desktop.apt-key", "warn", "chiave apt Anthropic assente dal repo: firma InRelease non verificabile", "curl -fsSL https://downloads.claude.ai/claude-desktop/key.asc -o pkg/claude-desktop/anthropic-apt.asc (fingerprint 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE)");
    else if (!(await has("gpgv"))) add("desktop.apt-key", "warn", "gpgv assente: la firma del repo apt non viene verificata", "pacman -S gnupg");
    else add("desktop.apt-key", "ok", "repo apt Anthropic: chiave pinnata nel repo, firma InRelease verificata a ogni update");
    const handler = await readText(`${HOME}/.local/share/applications/claude-code-url-handler.desktop`);
    if (handler && !handler.includes("claude-bin")) add("desktop.urlhandler", "fail", "url-handler claude-cli:// non punta a claude-bin", "claude-multi install");
  }
  // --- embedding locale per wiki-claude: llama.cpp + shim (niente Ollama su questa macchina)
  if (await lstat(`${HOME}/.local/opt/llama-vulkan/bin/llama-server`) && m.systemd) {
    for (const u of ["llama-embed.service", "llama-embed-shim.service"]) {
      const en = (await run("systemctl", ["--user", "is-enabled", u])).out; const act = (await run("systemctl", ["--user", "is-active", u])).out;
      if (en !== "enabled" || act !== "active") add(`llama.${u}`, "warn", `${u}: ${en}/${act}`, `systemctl --user enable --now ${u}`);
    }
    const gen = (await run("systemctl", ["--user", "is-enabled", "llama-generate.service"])).out;
    if (gen === "enabled") add("llama.generate", "warn", "llama-generate.service è abilitata al boot: deve restare on-demand (la gestisce lo shim)", "systemctl --user disable llama-generate.service");
    if (!(await readlink(`${HOME}/.config/systemd/user/llama-embed-shim.service`))?.startsWith(REPO)) add("llama.units", "warn", "unit llama-*.service non linkate dal repo", "claude-multi install");
  }
  if (!(await lstat(AGENTS_SKILLS))) add("agents.dir", "warn", "~/.agents/skills assente: le skill esterne non sono disponibili su questa macchina", "attiva la folder Syncthing `agents`");
  return c;
}
