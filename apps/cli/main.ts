#!/usr/bin/env -S deno run --quiet --allow-read --allow-write --allow-run --allow-env --allow-sys=hostname --allow-net=127.0.0.1:8384,127.0.0.1:7331
// agents-multi — CLI for a multi-profile Claude Code / Claude Desktop setup.
//
//   init    <folder>        a person's configuration (profiles, accounts, rules), linked from ~/.agents-multi/config
//   install [--app] [--dry-run]   materialise ~/.agents-multi, ~/.local/bin, units and .desktop entries (idempotent);
//                           --app: from the desktop app's code, installed first as the runtime's copy
//   migrate [app] [--dry-run] [--rollback]   move the runtime from ~/.claude-multi to ~/.agents-multi;
//                           app: move a checkout installation to the desktop app
//   settings [--dry-run] [--quiet]   regenerate each profile's settings.json, adopting what Claude wrote into it
//   doctor  [--probe] [--json|--notify [--dry-run]]   verify every invariant; --notify raises a desktop notification on new failures only;
//           --probe also sends each profile one tiny request (Haiku) to check its Claude Code login
//   status  [--json]        versions, updates, repo sync, profiles (what is mounted), running instances
//   sync    [--fetch]       align the repository (fetch when stale, ff-only pull on a clean tree)
//   mcp     check|sync|health [--force]   MCP registry to .claude.json (cli) and claude_desktop_config.json (desktop)
//   update  [...]           passthrough to bin/claude-update (CLI + Desktop, --rollback)
//   usage   [...]           tokens and list-price estimate per profile/model/project/agent/skill/command (SQLite)
//   serve   [--no-open]     local console on http://127.0.0.1:7331 (today, connections, profiles, plugins, updates, health)
//   tasks   [...]           the task list, its brief and the desktop reminders
//   vault   [...]           the MCP servers' secrets: encrypted in ~/vault/claude-multi, key in the keyring
//   version                 the version (deno.json), also --version / -V
//
// Principle: the repository is the source of truth, ~/.agents-multi is runtime materialised by
// `install` — from the desktop app's copy of the code, or from a checkout (lib/mode.ts). Launching Claude stays pure bash (bin/claude, the per-profile launchers, bin/lib/prelaunch.sh):
// management lives here. Zero external dependencies — Deno APIs plus the built-in node:sqlite — so
// it runs on a fresh machine with no cache to warm.

import { vaultCommand } from "./vault.ts";
import { tasksCommand } from "./tasks.ts";
import { googleCommand } from "./google.ts";
import { readJson } from "./lib/fs.ts";
import { ANSI, printDoctor } from "./lib/output.ts";
import { CACHE, HOME, PORT, REPO, STAMP, STATE } from "./lib/paths.ts";
import { ensureRuntimeLink } from "./lib/runtime-root.ts";
import { migrate } from "./migrate.ts";
import { migrateApp } from "./migrate-app.ts";
import { installApp } from "./appinstall.ts";
import { installation } from "./lib/mode.ts";
import { running } from "./lib/processes.ts";
import { amEnv } from "../../shared/mcp/lib/env.ts";
import { run } from "./lib/proc.ts";
import { doctor } from "./doctor/index.ts";
import { notifyDoctor } from "./notify.ts";
import { install } from "./install.ts";
import { init } from "./init.ts";
import { syncAllSettings } from "./settings.ts";
import { printStatus, status } from "./status.ts";
import { apply, blockers, describe, plan } from "./mcp/apply.ts";
import { health } from "./mcp/health.ts";
import { DB_PATH, type GroupBy, ingest, openDb, printReport, report } from "./usage.ts";
import { serve } from "./console/server.ts";
import { brainBackup } from "./brain-backup.ts";
import { brainLoginCommand } from "./brain-login.ts";
import { selfCheck, selfCheckRow, selfUpdate, settlePending } from "./selfupdate.ts";
import { brainAccount } from "../../shared/mcp/lib/brain-tasks.ts";
import { uiCommand } from "./ui.ts";
import manifest from "../../deno.json" with { type: "json" };

const [cmd = "help", ...rest] = Deno.args;
const flag = (f: string) => rest.includes(f);
const opt = (name: string, def?: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : def;
};

// A machine whose runtime has not moved yet gets ~/.agents-multi as a link to ~/.claude-multi,
// before anything here (settings, servers, install) writes a path with the new name.
if (!amEnv("ROOT")) await ensureRuntimeLink(HOME).catch(() => false);

switch (cmd) {
  case "migrate": {
    const procs = await running();
    if (rest[0] === "app") {
      Deno.exit(
        await migrateApp({
          dry: flag("--dry-run"),
          rollback: flag("--rollback"),
          force: flag("--force"),
          from: opt("--from"),
          to: opt("--to"),
          running: [
            ...procs.cli.map((p) => `claude ${p.profile ?? "?"} (pid ${p.pid})`),
            ...procs.desktop.map((p) => `Claude Desktop ${p.variant} (pid ${p.pid})`),
          ],
        }),
      );
    }
    const code = await migrate({
      home: HOME,
      dry: flag("--dry-run"),
      rollback: flag("--rollback"),
      force: flag("--force"),
      backupDir: `${STATE}/migrate-${STAMP}`,
      running: [
        ...procs.cli.map((p) => `claude ${p.profile ?? "?"} (pid ${p.pid})`),
        ...procs.desktop.map((p) => `Claude Desktop ${p.variant} (pid ${p.pid})`),
      ],
    });
    // the console and the tray found the runtime by its name when they started: they restart on the
    // new one, or they report the paths of the old (the console last: it may be the one asking)
    if (code === 0 && !flag("--dry-run")) {
      await run("systemctl", [
        "--user",
        "--no-block",
        "try-restart",
        "claude-multi-app.service",
        "claude-multi-console.service",
      ]);
    }
    Deno.exit(code);
    break;
  }
  case "init":
    Deno.exit(await init(rest));
    break;
  case "install":
    Deno.exit(flag("--app") ? await installApp({ dry: flag("--dry-run") }) : await install(flag("--dry-run")));
    break;
  case "settings": {
    const dry = flag("--dry-run");
    for (const r of await syncAllSettings({ dry })) {
      const pre = dry ? `${ANSI.d}(dry)${ANSI.x} ` : "";
      if (r.adopted.length) {
        console.log(`  ${pre}${r.profile}: adopted into profiles/${r.profile}/settings.json: ${r.adopted.join(", ")}`);
      }
      if (r.orphan) {
        console.log(`  ${pre}${r.profile}: settings.json had no record of being generated, kept aside as ${r.orphan}`);
      }
      if (r.wrote && !flag("--quiet")) {
        console.log(
          `  ${pre}${r.profile}/settings.json ${r.migrated ? "generated (was a link to shared/)" : "regenerated"}`,
        );
      }
    }
    break;
  }
  case "doctor": {
    const c = await doctor({ probe: flag("--probe") });
    if (flag("--notify")) {
      const sent = await notifyDoctor(c, { dryRun: flag("--dry-run") });
      console.log(sent ? "notification sent" : "nothing new, no notification");
      break;
    }
    if (flag("--json")) console.log(JSON.stringify(c, null, 2));
    else Deno.exit(printDoctor(c));
    break;
  }
  case "status": {
    const s = await status();
    if (flag("--json")) console.log(JSON.stringify(s, null, 2));
    else {
      printStatus(s);
      printDoctor(s.doctor);
    }
    break;
  }
  case "sync": {
    if ((await installation()).mode === "app") {
      console.log("the code is the desktop app's copy: it is updated with the app, there is no repository to align");
      break;
    }
    const env: Record<string, string> = flag("--fetch")
      ? { AGENTS_MULTI_FETCH_TTL: "0", AGENTS_MULTI_FETCH_TIMEOUT: "15" }
      : {};
    const r = await run("bash", [`${REPO}/bin/lib/prelaunch.sh`], { env });
    if (r.err) console.error(r.err);
    const st = await readJson(`${CACHE}/sync.json`) as Record<string, unknown> | null;
    if (st) {
      console.log(
        `repo ${st.upstream ? "" : "(no upstream) "}↓${st.behind} ↑${st.ahead} ✎${st.dirty}${
          st.pulled ? `  pulled +${st.pulled}` : ""
        }${st.fetch_ok ? "" : "  (fetch failed: offline?)"}`,
      );
    } else console.log("no sync state (repository without .git?)");
    break;
  }
  case "mcp": {
    const sub = rest[0] ?? "check";
    if (sub === "health") Deno.exit(printDoctor(await health({ live: flag("--probe") })));
    const { changes, skipped } = await plan();
    for (const t of skipped) console.log(`  ${ANSI.d}skipping ${t.managedKey}: ${t.path} is missing${ANSI.x}`);
    if (!changes.length) {
      console.log("MCP registry already applied on every surface");
      break;
    }
    for (const c of changes) console.log(`  ${describe(c)}`);
    if (sub === "check" || flag("--dry-run")) {
      console.log(`\n${changes.length} pending changes → agents mcp sync (with Claude closed)`);
      Deno.exit(1);
    }
    if (sub !== "sync") {
      console.error(`mcp: unknown subcommand "${sub}" (check|sync|health)`);
      Deno.exit(2);
    }
    try {
      await apply({ force: flag("--force") });
      // the registry's _deny/_ask live in each profile's generated settings.json
      for (const r of await syncAllSettings()) if (r.wrote) console.log(`  ${r.profile}/settings.json regenerated`);
      console.log(`\n${changes.length} changes applied. Restart the affected Claude instances to load them.`);
    } catch (e) {
      console.error(`\n! ${(e as Error).message}`);
      const b = await blockers();
      if (Object.keys(b).length) console.error(`  running: ${JSON.stringify(b)}`);
      Deno.exit(2);
    }
    break;
  }
  case "update": {
    const p = new Deno.Command(`${REPO}/bin/claude-update`, {
      args: rest,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    Deno.exit((await p.output()).code);
    break;
  }
  case "usage": {
    const db = openDb();
    if (rest[0] === "ingest" || !flag("--no-ingest")) {
      const t0 = Date.now();
      const r = await ingest(db, { full: flag("--full") });
      if (rest[0] === "ingest" || r.files) {
        console.error(
          `ingest: ${r.files} files read, ${r.msgs} messages, ${r.skipped} unchanged (${
            ((Date.now() - t0) / 1000).toFixed(1)
          }s) → ${DB_PATH}`,
        );
      }
      if (rest[0] === "ingest") break;
    }
    const rep = report(db, {
      by: opt("--by", "profile") as GroupBy,
      since: opt("--since", "30d"),
      profile: opt("--profile"),
      limit: Number(opt("--limit", "40")),
    });
    if (flag("--json")) console.log(JSON.stringify(rep, null, 2));
    else printReport(rep);
    break;
  }
  case "ui":
    Deno.exit(await uiCommand(rest));
    break;
  case "serve":
    await serve({ open: !flag("--no-open") });
    break;
  case "vault":
    Deno.exit(await vaultCommand(rest));
    break;
  case "tasks":
    Deno.exit(await tasksCommand(rest));
    break;
  case "brain-backup":
    Deno.exit(await brainBackup(flag("--force")));
    break;
  case "self-update": {
    if (flag("--check") && !flag("--json")) Deno.exit(await selfCheckRow());
    if (flag("--check")) {
      const c = await selfCheck();
      console.log(
        JSON.stringify({
          current: c.current,
          behind: c.behind,
          outdated: c.plan.do === "pull",
          blocked: c.plan.do === "skip" ? c.plan.why : null,
        }),
      );
      Deno.exit(c.plan.do === "pull" ? 10 : 0);
    }
    if (flag("--settle")) Deno.exit(await settlePending());
    Deno.exit(await selfUpdate({ quiet: flag("--quiet") }));
    break;
  }
  case "brain-login": {
    const account = rest[0] ?? brainAccount()?.name;
    if (!account) {
      console.error("no brain account in accounts.json: add one (service brain, with its address) first");
      Deno.exit(1);
    }
    Deno.exit(await brainLoginCommand(account));
    break;
  }
  case "google":
    Deno.exit(await googleCommand(rest));
    break;
  case "version":
  case "--version":
  case "-V":
    console.log(manifest.version);
    break;
  case "help":
  case "--help":
  case "-h":
  default:
    console.log(`agents-multi ${manifest.version} — manage a multi-profile Claude setup (repository ${REPO})

  init    <folder> [--name N] [--language L]   your configuration (profiles, accounts, rules, preferences), linked from ~/.agents-multi/config
  install [--app] [--dry-run] materialise runtime, wrappers, units and desktop entries (idempotent);
          --app: from the desktop app's code, which becomes the runtime's copy (what the app runs)
  migrate [--dry-run] [--rollback] [--force]   move the runtime from ~/.claude-multi to ~/.agents-multi (with Claude closed)
  migrate app [--from <package code>] [--dry-run] [--rollback [--to <checkout>]] [--force]
          move this machine from a checkout to the desktop app's code (with Claude closed)
  doctor  [--probe] [--json|--notify]   verify the setup's invariants, each with a suggested fix; --notify: desktop notification on new failures only;
          --probe: one tiny request per profile, to see that its Claude Code login works
  status  [--json]            versions, updates, repository sync, profiles and what is mounted, running instances
  sync    [--fetch]           align the repository (fetch when stale, ff-only pull on a clean tree)
  mcp     check|sync|health [--probe]   MCP registry to .claude.json (cli) and claude_desktop_config.json (desktop); --force ignores running instances; --probe really starts each server and waits for initialize
  update  [--cli|--desktop|--self|--auto|--check [--json]|--rollback [--desktop]]   update Claude Code, Claude Desktop and agents-multi itself (--auto: what the timer runs)
  self-update [--check [--json]] [--settle] [--quiet]   agents-multi itself: ff-only pull on a clean tree, then restarts what runs old code and installs (with Claude closed)
  usage   [ingest [--full]] [--by profile|model|project|agent|day|session|entrypoint|skill|command]
          [--since 30d|7d|all|YYYY-MM-DD] [--profile p] [--limit n] [--no-ingest] [--json]
  vault   [status|init|pair|recovery-code|set|delete|run]   the MCP servers' secrets: encrypted,
          in ~/vault/claude-multi (Syncthing), key in this machine's keyring
  google  client <file.json> | connect <account>   the Google OAuth client, and connecting an account
  tasks   [brief|add|done|remind|migrate]   the task list (in the brain); remind is what claude-tasks.timer runs
  brain-login [account]       sign this machine in to the brain: token and backup key into the vault, nothing to copy
  brain-backup [--force]      a sealed copy of the brain here, only when it changed (claude-brain-backup.timer)
  ui      build               build the console's interface (apps/ui, pnpm) that serve shows
  serve   [--no-open]         local console on http://127.0.0.1:${PORT} (today, connections, profiles, plugins, updates, health)
  version                     the version of agents-multi (also --version, -V)

  agents-multi and claude-multi are other names for the same command (the second is the project's name before Agents Multi).

  The desktop app serves the console and starts at login in the tray; without it (a headless box),
  agents serve runs it by hand.`);
    if (!["help", "--help", "-h"].includes(cmd)) Deno.exit(2);
}
