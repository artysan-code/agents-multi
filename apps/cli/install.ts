// install.ts — materialise the runtime from the code. Idempotent: run it whenever, --dry-run to look first.
// Rule: never delete real content. It is moved aside to *.pre-repo-<stamp>, and said out loud.
//
// The code is the installation's (lib/mode.ts): in app mode the copy of the app's code
// (~/.agents-multi/app/current, appcopy.ts), in dev mode the checkout this runs from. Every link
// install makes points into it; what install reads (bin/, shared/, systemd/, desktop/) comes from it.

import { listDir, lstat, mode, readlink, readText, stat } from "./lib/fs.ts";
import { GIT_IGNORED, gitGlobalIgnore, missingIgnores } from "./lib/git.ts";
import { machine } from "./lib/machine.ts";
import { ANSI, printDoctor } from "./lib/output.ts";
import {
  AGENTS_SKILLS,
  BIN,
  CONFIG,
  HOME,
  LIB,
  PROFILES,
  REPO,
  RUNTIME,
  shortHome,
  STAMP,
  STIGNORE_GEN_TEMPLATE_IN_REPO,
  SYNCTHING_CONFIG,
} from "./lib/paths.ts";
import { COPY_SHARED, type Installation, installation, isCheckout, type Mode } from "./lib/mode.ts";
import { has, run, which } from "./lib/proc.ts";
import {
  desktopDir,
  type Kind,
  KINDS,
  launchers,
  loadManifest,
  ownItems,
  type Profile,
  profileNames,
} from "./lib/profiles.ts";
import { ZSH_BEGIN, ZSH_END, zshBlock } from "./lib/shell.ts";
import { doctor } from "./doctor/index.ts";
import { syncSettings } from "./settings.ts";
import { loadAccounts } from "../../shared/mcp/lib/accounts.ts";
import { brainAccount } from "../../shared/mcp/lib/brain-tasks.ts";
import { uiBuild, uiStatus } from "./ui.ts";

let DRY = false;
/** Where the links point (the installation's code) and where what install reads is read from: the
 *  same folder, except on a dry run in app mode before the copy exists, which reads the running code. */
let CODE = REPO;
let SRC = REPO;
const actions: string[] = [];
/** What the last run did, or on a dry run would do: one line per change. */
export const installActions = (): readonly string[] => [...actions];
function say(s: string) {
  actions.push(s);
  console.log(`  ${DRY ? `${ANSI.d}(dry)${ANSI.x} ` : ""}${s}`);
}

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
  const tpl = await readText(`${SRC}/desktop/entry.desktop.in`);
  if (tpl === null) return;
  const body = tpl.slice(tpl.indexOf("[Desktop Entry]"));
  const defaultProfile = (await launchers()).find((l) => l.command === "claude")?.profile;
  for (const p of await profileNames()) {
    const { file, text } = await desktopEntry(p, body, defaultProfile);
    const cur = await readText(`${apps}/${file}`);
    if (cur === text) continue;
    say(`${ANSI.g}+${ANSI.x} ${shortHome(`${apps}/${file}`)} (profile ${p})`);
    if (!DRY) {
      await Deno.mkdir(apps, { recursive: true });
      await Deno.writeTextFile(`${apps}/${file}`, text);
    }
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
    .replaceAll(
      "@COMMENT@",
      variant ? `Claude Desktop — ${title} profile (separate icon and app_id)` : "Desktop application for Claude.ai",
    )
    .replaceAll("@LAUNCH@", `${BIN}/claude-launch`)
    .replaceAll("@PROFILE@", p)
    .replaceAll("@KEYWORD@", variant ? `${title};` : "")
    .replaceAll("@ICON@", variant ? `claude-desktop-${p}` : "claude-desktop")
    .replaceAll("@WMCLASS@", variant ? `claude-desktop-${p}` : "com.anthropic.Claude")
    .replaceAll(
      "@MIME@",
      p === defaultProfile
        ? "MimeType=x-scheme-handler/claude;"
        : "# no scheme handler: claude:// belongs to the default profile",
    );
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
  const a = await readText(src);
  const b = await readText(dst);
  if (a !== null && a === b) return;
  say(`${ANSI.g}+${ANSI.x} copio ${dst}`);
  if (!DRY) {
    await Deno.mkdir(dst.slice(0, dst.lastIndexOf("/")), { recursive: true });
    await Deno.copyFile(src, dst);
  }
}
/** A text file with @BIN@ filled in: a .desktop Exec= needs an absolute path, and the repository
 *  must not carry this machine's home directory. */
async function ensureRendered(src: string, dst: string) {
  const a = (await readText(src))?.replaceAll("@BIN@", BIN) ?? null;
  const b = await readText(dst);
  if (a === null || a === b) return;
  say(`${ANSI.g}+${ANSI.x} writing ${dst}`);
  if (!DRY) {
    await Deno.mkdir(dst.slice(0, dst.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(dst, a);
  }
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
 *  ~/.agents-multi/personal/skills -> ../shared/skills -> <repo>/shared/skills. Claude Code writes
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
  if (st?.isSymlink) {
    say(`${ANSI.y}→${ANSI.x} ${p}/${kind} was a symlink: becoming a real directory`);
    if (!DRY) await Deno.remove(dir);
  }
  await ensureDir(dir);
  // the shared items the profile links resolve to: the mounted code's (CODE), which also holds the
  // links to ~/.agents/skills; the code being run (SRC) is the package's during `migrate app`
  const shared = (await stat(`${CODE}/shared/${kind}`)) ? `${CODE}/shared/${kind}` : `${SRC}/shared/${kind}`;
  // "all" mounts what really is an item of that kind, exactly like sharedInventory() counts them:
  // a skill is a directory with a SKILL.md, an agent or a command is a .md file — and AGENTS.md is
  // the catalog of the directory, not an agent. Anything else (a sync bucket, a stray file) is left
  // alone. The doctor still reports it: not mounting it is not the same as condoning it.
  const sharedNames = spec === "all"
    ? (await Promise.all(
      (await listDir(shared)).map(async (n) =>
        (kind === "skills" ? !!(await lstat(`${shared}/${n}/SKILL.md`)) : n.endsWith(".md") && n !== "AGENTS.md")
          ? n
          : null
      ),
    ))
      .filter((n): n is string => n !== null)
    : spec.map((n) => kind === "skills" || n.endsWith(".md") ? n : `${n}.md`);
  const expected = new Set<string>();
  for (const n of sharedNames) {
    if (!(await lstat(`${shared}/${n}`))) {
      say(`${ANSI.r}!${ANSI.x} ${p}/${kind}: "${n}" does not exist in shared/${kind} (fix the manifest)`);
      continue;
    }
    expected.add(n);
    await ensureSymlink(`../../shared/${kind}/${n}`, `${dir}/${n}`, `${p}/${kind}/${n}`);
  }
  for (const n of own) {
    expected.add(n);
    await ensureSymlink(`${PROFILES}/${p}/${kind}/${n}`, `${dir}/${n}`, `${p}/${kind}/${n}`);
  }
  // links the manifest does not call for: removed only when they are symlinks. Real content stays
  // untouched — it is the profile's own runtime (skills/synced/, agents created in session).
  for (const n of await listDir(dir)) {
    if (expected.has(n)) continue;
    const s = await lstat(`${dir}/${n}`);
    if (s?.isSymlink) await removeLink(`${dir}/${n}`, "not in the manifest");
  }
}

/** Pure: the code an installation's links point into. Dev installs the checkout it runs from, as
 *  ever; the app's code running on a dev installation (the app's backend, before `migrate app`) keeps
 *  the installation's checkout instead of pointing it into the package. */
export function codeFor(inst: Installation, running: string, runningIsCheckout: boolean): string {
  return inst.mode === "dev" && runningIsCheckout ? running : inst.code;
}

/** The units the desktop app replaced: install stops, disables and removes them (docs/adr/0003). */
export const RETIRED_UNITS = ["claude-multi-console.service", "claude-multi-app.service"];
/**
 * Pure: the units in the user's unit folder (each with where its link points, null for a file) that
 * install removes: in both modes the ones the app replaced; in app mode also every one of ours — a
 * link into some code's systemd/user, as install makes them — since the app runs their jobs.
 */
export function unitsToRetire(mode: Mode, units: { name: string; target: string | null }[]): string[] {
  return units.filter(({ name, target }) =>
    RETIRED_UNITS.includes(name) || (mode === "app" && !!target?.endsWith(`/systemd/user/${name}`))
  ).map((u) => u.name);
}
/** Menu entries an older install wrote, now the package's own (its desktop file is the app's entry). */
const RETIRED_ENTRIES = ["claude-multi.desktop", "claude-update-gui.desktop"];
/** The login entry that starts the app in the tray (XDG autostart). */
export const AUTOSTART = "agents-multi.desktop";

/** The desktop app's executable: the runtime's link to the package's (appcopy.ts), else on PATH. */
export async function appExecutable(): Promise<string | null> {
  const own = `${RUNTIME}/bin/agents-multi-desktop`;
  return (await stat(own)) ? own : await which("agents-multi-desktop");
}

/** The app's menu entry, named after its window's app_id so the panel groups the two. */
const APP_ENTRY = "me.artysan.agents.desktop";
/** Pure: the menu entry install writes for an AppImage, which brings none (a deb or an rpm does). */
export const appImageEntry = (app: string) =>
  [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Agents Multi",
    `Exec=${app}`,
    "Icon=claude-multi",
    "StartupWMClass=me.artysan.agents",
    "StartupNotify=true",
    "Terminal=false",
    "Categories=Development;",
    "",
  ].join("\n");

/** Pure: the autostart entry, from desktop/autostart.desktop.in. */
export const autostartEntry = (template: string, bin: string) =>
  template.slice(template.indexOf("[Desktop Entry]")).replaceAll("@BIN@", bin);

/**
 * Materialises the runtime. `as` names the installation to install (agents migrate app plans one
 * before the runtime is one); otherwise it is this machine's.
 */
export async function install(
  dry: boolean,
  opts: { as?: Installation; src?: string; diagnose?: boolean } = {},
) {
  DRY = dry;
  actions.length = 0;
  const m = await machine();
  const inst = opts.as ?? await installation();
  CODE = codeFor(inst, REPO, await isCheckout(REPO));
  SRC = opts.src ?? ((await stat(`${CODE}/apps/cli/main.ts`)) ? CODE : REPO);
  const dev = inst.mode === "dev";
  console.log(
    `${ANSI.b}agents install${ANSI.x} — ${dev ? "checkout" : "the app's code"} ${
      shortHome(CODE)
    } → runtime ${RUNTIME} (${m.hostname}${DRY ? ", dry-run" : ""})\n`,
  );
  if (!dev && !(await stat(`${SRC}/apps/cli/main.ts`))) {
    console.log(`  ${ANSI.r}✗${ANSI.x} no copy of the app's code in ${shortHome(CODE)}: start the app, it installs it`);
    return 1;
  }

  // 0. the person's configuration: without it there is no profile to install
  if (!(await stat(`${CONFIG}/owner.json`))) {
    console.log(
      `  ${ANSI.r}✗${ANSI.x} no configuration at ${
        shortHome(CONFIG)
      }: make one with  agents init <folder>  (or link an existing one there)`,
    );
    return 1;
  }

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
  await ensureDir(AGENTS_SKILLS);
  for (const s of await listDir(AGENTS_SKILLS)) {
    if (!(await lstat(`${AGENTS_SKILLS}/${s}/SKILL.md`))) continue;
    if (!(await lstat(`${CODE}/shared/skills/${s}`))) {
      await ensureSymlink(`${AGENTS_SKILLS}/${s}`, `${CODE}/shared/skills/${s}`, `shared/skills/${s} (da ~/.agents)`);
    }
  }
  // broken links in shared/skills (old relative paths, uninstalled skills)
  for (const s of await listDir(`${CODE}/shared/skills`)) {
    const p = `${CODE}/shared/skills/${s}`;
    const st = await lstat(p);
    if (st?.isSymlink && !(await lstat(`${p}/SKILL.md`))) {
      const t = await readlink(p) ?? "";
      const name = t.split("/").pop() ?? s;
      if (await lstat(`${AGENTS_SKILLS}/${name}/SKILL.md`)) {
        await ensureSymlink(`${AGENTS_SKILLS}/${name}`, p, `shared/skills/${s} (ricreato)`);
      } else await removeLink(p, "broken link, skill no longer in ~/.agents");
    }
  }

  // 3. shared → the code: the copy's (relative, through app/current) or the checkout's
  await ensureSymlink(dev ? `${CODE}/shared` : COPY_SHARED, `${RUNTIME}/shared`, "~/.agents-multi/shared");

  // 4. profili
  for (const p of await profileNames()) {
    const dir = `${RUNTIME}/${p}`;
    await ensureDir(dir, 0o700);
    await ensureSymlink(`${PROFILES}/${p}/CLAUDE.md`, `${dir}/CLAUDE.md`, `${p}/CLAUDE.md`);
    // settings.json is generated (settings.ts): shared ⊕ the person's ⊕ the profile's patch ⊕ the manifest.
    const set = await syncSettings(p, { dry: DRY });
    if (set.adopted.length) {
      say(
        `${ANSI.y}→${ANSI.x} ${p}: adopting what Claude wrote into config/profiles/${p}/settings.json: ${
          set.adopted.join(", ")
        }`,
      );
    }
    if (set.orphan) {
      say(
        `${ANSI.r}!${ANSI.x} ${p}/settings.json was a file with no record of generating it: kept aside as ${
          shortHome(set.orphan)
        }`,
      );
    }
    if (set.migrated) say(`${ANSI.y}→${ANSI.x} ${p}/settings.json: from a link to shared/ to a generated file`);
    else if (set.wrote) say(`${ANSI.g}+${ANSI.x} ${p}/settings.json regenerated`);
    await ensureSymlink("../shared/hooks", `${dir}/hooks`, `${p}/hooks`);
    await ensureDir(`${dir}/plugins`);
    await ensureSymlink("../../marketplaces", `${dir}/plugins/marketplaces`, `${p}/plugins/marketplaces`);
    const manifest = await loadManifest(p);
    for (const k of KINDS) await materializeKind(p, k, manifest[k]);
    const creds = await lstat(`${dir}/.credentials.json`);
    if (creds && mode(creds) !== "600") {
      say(`${ANSI.y}→${ANSI.x} chmod 600 ${p}/.credentials.json`);
      if (!DRY) await Deno.chmod(`${dir}/.credentials.json`, 0o600);
    }
  }

  // 5. ~/.local/bin e ~/.local/lib
  await ensureDir(BIN);
  for (const b of await listDir(`${SRC}/bin`)) {
    if (b === "lib") continue;
    await ensureSymlink(`${CODE}/bin/${b}`, `${BIN}/${b}`, `~/.local/bin/${b}`);
  }
  // Each profile gets its launcher name pointed at the one wrapper, which identifies the profile
  // from the name it is invoked as. A new profile needs no new file in bin/.
  for (const l of await launchers()) {
    await ensureSymlink(`${CODE}/bin/claude`, `${BIN}/${l.command}`, `~/.local/bin/${l.command}`);
  }
  await ensureSymlink(
    `${CODE}/shared/tools/stignore-gen/stignore-gen.ts`,
    `${BIN}/stignore-gen`,
    "~/.local/bin/stignore-gen",
  );
  if (await lstat(`${BIN}/claude-multi-finalize`)) {
    await removeLink(`${BIN}/claude-multi-finalize`, "superato da doctor");
  }
  // updates install themselves now: the notifier that offered to install them is gone
  if ((await lstat(`${BIN}/claude-update-notify`))?.isSymlink) {
    await removeLink(`${BIN}/claude-update-notify`, "updates install themselves");
  }
  // the wiki distiller is gone (2026-10-02): the memory is the brain now
  if ((await lstat(`${BIN}/claude-distiller`))?.isSymlink) {
    await removeLink(`${BIN}/claude-distiller`, "the memory is the brain now");
  }
  // claude-personal, an alias that named one person's profile, is gone: each profile's command comes
  // from its manifest (a profile whose command is claude-personal still gets it, linked to bin/claude)
  if ((await readlink(`${BIN}/claude-personal`))?.endsWith("/bin/claude-personal")) {
    await removeLink(`${BIN}/claude-personal`, "an alias of the personal profile, now its manifest's command");
  }
  await ensureDir(LIB);
  // The update GUI became the desktop app (bin/claude-multi-app finds its code through the repo).
  for (const old of [`${LIB}/claude-update-gui`, `${BIN}/claude-update-gui`]) {
    if ((await lstat(old))?.isSymlink) await removeLink(old, "replaced by claude-multi-app");
  }

  // 5b. the checkout's git hooks (pre-commit: secret guard + type check)
  if (dev && await isCheckout(CODE)) {
    const hooks = (await run("git", ["-C", CODE, "config", "--get", "core.hooksPath"])).out;
    if (hooks !== ".githooks") {
      say(`${ANSI.g}+${ANSI.x} git core.hooksPath → .githooks (pre-commit)`);
      if (!DRY) await run("git", ["-C", CODE, "config", "core.hooksPath", ".githooks"]);
    }
  }

  // 5c. stignore-gen's git template: a repository cloned inside a Syncthing folder gets its .stignore block
  // from the post-checkout hook before Syncthing picks its files up (the timer of step 8 is the safety net).
  if (await lstat(SYNCTHING_CONFIG)) {
    const tpl = (await run("git", ["config", "--global", "--get", "init.templateDir"])).out;
    const want = `${CODE}/${STIGNORE_GEN_TEMPLATE_IN_REPO}`;
    if (tpl !== want) {
      say(`${ANSI.g}+${ANSI.x} git init.templateDir → stignore-gen template${tpl ? ` (was ${tpl})` : ""}`);
      if (!DRY) await run("git", ["config", "--global", "init.templateDir", want]);
    }
  }

  // 5d. git's global ignore: what a project keeps for agents-multi stays out of every repository
  {
    const file = await gitGlobalIgnore();
    const text = await readText(file) ?? "";
    const add = missingIgnores(text, GIT_IGNORED);
    if (add.length) {
      say(`${ANSI.g}+${ANSI.x} ${shortHome(file)}: ${add.join(", ")}`);
      if (!DRY) {
        await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
        await Deno.writeTextFile(file, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${add.join("\n")}\n`);
      }
    }
  }

  // 6. stub ~/.claude (mode 500: stat fails with ENOENT on the settings, so Claude Code shows no "Settings Error")
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) {
    say(`${ANSI.g}+${ANSI.x} stub ~/.claude (500)`);
    if (!DRY) {
      await Deno.mkdir(`${HOME}/.claude`);
      await Deno.chmod(`${HOME}/.claude`, 0o500);
    }
  } else if (stub.isDirectory && mode(stub) !== "500") {
    say(`${ANSI.y}→${ANSI.x} chmod 500 ~/.claude`);
    if (!DRY) await Deno.chmod(`${HOME}/.claude`, 0o500);
  }

  // 7. ~/.zshrc
  const zp = `${HOME}/.zshrc`;
  const zsh = await readText(zp);
  if (zsh !== null) {
    const block = await zshBlock();
    const re = new RegExp(`${ZSH_BEGIN.replace(/[()]/g, "\\$&")}[\\s\\S]*?${ZSH_END}`);
    const next = re.test(zsh) ? zsh.replace(re, block) : `${zsh.trimEnd()}\n\n${block}\n`;
    if (next !== zsh) {
      say(`${ANSI.y}→${ANSI.x} updating the agents-multi block in ~/.zshrc`);
      if (!DRY) await Deno.writeTextFile(zp, next);
    }
  }

  // 8. systemd user units: dev mode only. In app mode the app's backend schedules their jobs while it
  // runs (console/schedule.ts), so nothing depends on systemd, and the units an earlier install made go.
  {
    const ud = `${HOME}/.config/systemd/user`;
    const present = await Promise.all(
      (await listDir(ud)).map(async (name) => ({ name, target: await readlink(`${ud}/${name}`) })),
    );
    const gone = unitsToRetire(inst.mode, present);
    if (dev && m.systemd) {
      await ensureDir(ud);
      for (const u of await listDir(`${SRC}/systemd/user`)) {
        await ensureSymlink(`${CODE}/systemd/user/${u}`, `${ud}/${u}`, `systemd/user/${u}`);
      }
      // a unit removed from the code leaves its link behind: drop the ones pointing at nothing
      for (const { name: u, target } of present) {
        if (target?.endsWith(`/systemd/user/${u}`) && !gone.includes(u) && !(await lstat(target))) {
          say(`${ANSI.y}-${ANSI.x} ${shortHome(`${ud}/${u}`)} (no longer in the repository)`);
          if (!DRY) {
            await run("systemctl", ["--user", "disable", "--now", u]); // a linked unit: disable removes the link itself
            await Deno.remove(`${ud}/${u}`).catch(() => {});
          }
        }
      }
      if (!DRY) {
        await run("systemctl", ["--user", "daemon-reload"]);
        // The console is the desktop app's now (its backend), and the app starts at login from its
        // autostart entry (step 10); a headless box runs `agents serve` by hand.
        const wantEnabled: string[] = [];
        // The update check raises desktop notifications, so it only makes sense with a session.
        if (m.graphical) wantEnabled.push("claude-update-check.timer");
        // task briefs and reminders are desktop notifications: only where there is a desktop
        if (m.graphical) wantEnabled.push("claude-tasks.timer");
        // a copy of the brain on every machine that is on, fetched only when it changed
        if (brainAccount(undefined, loadAccounts())) wantEnabled.push("claude-brain-backup.timer");
        // Keeps the git repositories inside Syncthing folders out of Syncthing: only where Syncthing runs.
        if (await lstat(SYNCTHING_CONFIG)) wantEnabled.push("stignore-gen.timer");
        for (const u of wantEnabled) {
          const en = await run("systemctl", ["--user", "is-enabled", u]);
          if (en.out !== "enabled") {
            say(`${ANSI.g}+${ANSI.x} enable --now ${u}`);
            await run("systemctl", ["--user", "enable", "--now", u]);
          }
        }
      }
    }
    // Stopped last and without waiting: the console's unit may be what runs this install (its «Close
    // Claude and update»), and stopping it ends whatever runs inside it. The files are this HOME's
    // either way; the manager is told only when it is this HOME's (machine.ts).
    if (gone.length) {
      say(
        `${ANSI.y}-${ANSI.x} systemd units ${gone.join(", ")} (${
          dev ? "replaced by the desktop app" : "the app runs their jobs"
        })`,
      );
      if (!DRY) {
        if (m.systemd) await run("systemctl", ["--user", "disable", ...gone]);
        for (const u of gone) await Deno.remove(`${ud}/${u}`).catch(() => {});
        if (m.systemd) {
          await run("systemctl", ["--user", "daemon-reload"]);
          // one unit per call: systemctl enqueues nothing when any unit it is given is not loaded (a
          // service whose file is gone and that was not running), and the running ones kept going
          for (const u of gone) {
            await run("systemctl", ["--user", "--no-block", "stop", u]);
            // a timer whose service vanished is left «failed»
            await run("systemctl", ["--user", "reset-failed", u]);
          }
        }
      }
    }
  }

  // 9. Claude Desktop (only where it is installed)
  if (m.desktopVersion) {
    const apps = `${HOME}/.local/share/applications`;
    for (const d of await listDir(`${SRC}/desktop`)) {
      if (d.endsWith(".desktop")) await ensureRendered(`${SRC}/desktop/${d}`, `${apps}/${d}`);
    }
    // copies an older install wrote, of files the code no longer has
    for (const d of RETIRED_ENTRIES) {
      if (await lstat(`${apps}/${d}`)) await removeLink(`${apps}/${d}`, "the desktop app's package has its own entry");
    }
    await writeDesktopEntries(apps);
    // the icons of the person's Desktop profiles (config/icons/<size>/claude-desktop-<profile>.png)
    for (const root of [`${SRC}/desktop/icons`, `${CONFIG}/icons`]) {
      for (const s of await listDir(root)) {
        for (const f of await listDir(`${root}/${s}`)) {
          await ensureCopy(`${root}/${s}/${f}`, `${HOME}/.local/share/icons/hicolor/${s}/apps/${f}`);
        }
      }
    }
    const handlerP = `${apps}/claude-code-url-handler.desktop`;
    const handler = await readText(handlerP);
    if (handler && /Exec=.*\/claude"? --handle-uri/.test(handler) && !handler.includes("claude-bin")) {
      say(`${ANSI.y}→${ANSI.x} url-handler claude-cli:// → claude-bin`);
      if (!DRY) {
        await Deno.writeTextFile(
          handlerP,
          handler.replace(/^Exec=.*--handle-uri/m, `Exec="${BIN}/claude-bin" --handle-uri`),
        );
      }
    }
    if (!DRY) {
      if (await has("update-desktop-database")) await run("update-desktop-database", [apps]);
      if (await has("gtk-update-icon-cache")) {
        await run("gtk-update-icon-cache", ["-q", `${HOME}/.local/share/icons/hicolor`]);
      }
      if (await has("kbuildsycoca6")) await run("kbuildsycoca6", ["--noincremental"]);
    }
  } else {
    console.log(`  ${ANSI.d}Claude Desktop is not installed: skipping desktop entries and icons${ANSI.x}`);
  }

  // 10. the desktop app at login, in the tray: wherever there is a session and the app is installed
  if (m.graphical) {
    const entry = `${HOME}/.config/autostart/${AUTOSTART}`;
    const tpl = await readText(`${SRC}/desktop/autostart.desktop.in`);
    if (tpl !== null && await appExecutable()) {
      const text = autostartEntry(tpl, BIN);
      if ((await readText(entry)) !== text) {
        say(`${ANSI.g}+${ANSI.x} ${shortHome(entry)} (the app in the tray at login)`);
        if (!DRY) {
          await Deno.mkdir(`${HOME}/.config/autostart`, { recursive: true });
          await Deno.writeTextFile(entry, text);
        }
      }
    } else if (tpl !== null && dev) {
      console.log(`  ${ANSI.d}the desktop app is not installed: no autostart entry${ANSI.x}`);
    }
    // an AppImage has no menu entry until someone writes one: the runtime's link to it, and its icon
    const app = await appExecutable();
    if (app && /\.AppImage$/i.test(await Deno.realPath(app).catch(() => app))) {
      const apps = `${HOME}/.local/share/applications`;
      const text = appImageEntry(app);
      if ((await readText(`${apps}/${APP_ENTRY}`)) !== text) {
        say(`${ANSI.g}+${ANSI.x} ${shortHome(`${apps}/${APP_ENTRY}`)} (the AppImage in the menu)`);
        if (!DRY) {
          await Deno.mkdir(apps, { recursive: true });
          await Deno.writeTextFile(`${apps}/${APP_ENTRY}`, text);
        }
      }
      for (const size of await listDir(`${SRC}/desktop/icons`)) {
        const icon = `${SRC}/desktop/icons/${size}/claude-multi.png`;
        if (await stat(icon)) {
          await ensureCopy(icon, `${HOME}/.local/share/icons/hicolor/${size}/apps/claude-multi.png`);
        }
      }
    }
  }

  // the console's new interface: built here in a checkout, not counted as install work, since
  // self-update builds it on its own and an install waiting for Claude to close must not wait for it;
  // the app's code carries its build
  if (!DRY && dev && CODE === REPO && (await uiStatus()) !== "built") {
    const b = await uiBuild();
    console.log(
      b.ok ? `  ${ANSI.g}✓${ANSI.x} console interface built` : `  ${ANSI.y}!${ANSI.x} console interface: ${b.error}`,
    );
  }

  if (!actions.length) console.log(`  ${ANSI.g}✓${ANSI.x} everything already materialised, nothing to do`);
  console.log();
  if (opts.diagnose === false) return 0;
  // The diagnosis is printed, but it is not this command's verdict: install reports whether it
  // materialised the runtime, not whether the machine is healthy. Returning the doctor's code made
  // `agents install && <next step>` skip the next step exactly when the doctor was
  // complaining about something that step would have fixed — a missing Desktop variant, say.
  // `agents doctor` is the command whose exit code means "healthy".
  const failed = printDoctor(await doctor());
  if (failed) {
    console.log(
      `  ${ANSI.d}install finished; the checks above are a diagnosis, not a failure of this command.${ANSI.x}`,
    );
    console.log(`  ${ANSI.d}Run their fixes, then \`agents doctor\` to confirm.${ANSI.x}\n`);
  }
  return 0;
}
