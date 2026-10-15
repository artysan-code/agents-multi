#!/usr/bin/env -S deno run --quiet --allow-read --allow-write --allow-run --allow-env --allow-sys=hostname --allow-net=127.0.0.1:8384,127.0.0.1:7331
// agents-multi — the CLI of a multi-profile Claude Code / Claude Desktop setup. The commands are
// dispatched below; `agents help` lists them and is the one place that says what each does.

import { vaultCommand } from "./vault.ts";
import { tasksCommand } from "./tasks.ts";
import { agentCommand } from "./agent.ts";
import { runCommand } from "./run.ts";
import { routineCommand } from "./routine.ts";
import { accountCommand } from "./account.ts";
import { googleCommand } from "./google.ts";
import { readJson } from "./lib/fs.ts";
import { ANSI, printDoctor } from "./lib/output.ts";
import { CACHE, PORT, REPO } from "./lib/paths.ts";
import { installApp } from "./appinstall.ts";
import { installation } from "./lib/mode.ts";
import { run } from "./lib/proc.ts";
import { doctor } from "./doctor/index.ts";
import { notifyDoctor } from "./notify.ts";
import { install } from "./install.ts";
import { init } from "./init.ts";
import { syncAllSettings } from "./settings.ts";
import { printStatus, status } from "./status.ts";
import { describe, plan } from "./mcp/apply.ts";
import { staleLaunchConfigs } from "./mcp/config.ts";
import { health } from "./mcp/health.ts";
import { DB_PATH, type GroupBy, ingest, openDb, printReport, report } from "./usage.ts";
import { serve } from "./console/server.ts";
import { gatewayCli } from "./console/gateway.ts";
import { gatewayConfig, serverVersion, syncGateway, warmCache } from "./mcp/gateway.ts";
import { loadRegistry } from "./mcp/registry.ts";
import { brainBackup } from "./brain-backup.ts";
import { brainLoginCommand } from "./brain-login.ts";
import { codexCommand } from "./codex.ts";
import { limitsCommand } from "./limits.ts";
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

// A command that fails says why in one line, not with Deno's stack: the scheduled jobs (tasks remind,
// brain-backup) log what they print, and a brain away for a deploy is a message, not a crash.
globalThis.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  console.error(`agents ${cmd}: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`);
  Deno.exit(1);
});

switch (cmd) {
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
        console.log(`  ${pre}${r.profile}/settings.json regenerated`);
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
    if (sub === "check") {
      // the launch configs against the registry, Desktop's servers against what Desktop has
      const stale = await staleLaunchConfigs();
      for (const p of stale) {
        console.log(`  cli:${p.padEnd(13)} launch config out of date (rebuilt at the next launch)`);
      }
      const { changes, skipped } = await plan();
      for (const t of skipped) console.log(`  ${ANSI.d}skipping ${t.managedKey}: ${t.path} is missing${ANSI.x}`);
      for (const c of changes) console.log(`  ${describe(c)}`);
      if (!stale.length && !changes.length) console.log("MCP launch configs and Desktop servers match the registry");
      else console.log(`\nagents mcp sync brings them up to date (no Claude needs closing)`);
      break;
    }
    if (sub === "warm") {
      // the gateway's tool lists, built now instead of by the first session that needs them (ADR 0008)
      const reg = await loadRegistry();
      if (!reg.gateway?.enabled) {
        console.log("the MCP gateway is off: nothing to warm");
        break;
      }
      await syncGateway(reg);
      const r = await warmCache(await gatewayConfig(reg, serverVersion), reg.gateway.runtime, {
        dry: flag("--dry-run"),
        force: flag("--force"),
      });
      for (const b of r.built) console.log(`  ${flag("--dry-run") ? "would build" : "built"} ${b}`);
      for (const f of r.failed) console.error(`  failed ${f}`);
      for (const f of r.removed) console.log(`  ${flag("--dry-run") ? "would remove" : "removed"} cache/${f}`);
      if (!r.built.length && !r.failed.length && !r.removed.length) console.log("every tool list is cached");
      if (r.failed.length) Deno.exit(1);
      break;
    }
    if (sub !== "sync") {
      console.error(`mcp: unknown subcommand "${sub}" (check|sync|health|warm)`);
      Deno.exit(2);
    }
    for (const r of await syncAllSettings()) {
      if (r.wrote) console.log(`  ${r.profile}/settings.json regenerated`);
      if (r.mcp?.wrote) console.log(`  ${r.profile}/mcp.json regenerated`);
      if (r.mcp?.retired.length) console.log(`  ${r.profile}: took ${r.mcp.retired.join(", ")} out of .claude.json`);
      if (r.mcp?.error) console.error(`  ${r.profile}: ${r.mcp.error}`);
    }
    const left = await plan();
    if (left.changes.length) {
      console.log(`  Desktop: ${left.changes.length} changes wait for its window to be closed (applied when it opens)`);
    }
    break;
  }
  case "gateway":
    Deno.exit(await gatewayCli(rest));
    break;
  case "codex":
    Deno.exit(await codexCommand(rest));
    break;
  case "limits":
    Deno.exit(await limitsCommand(rest));
    break;
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
          `ingest: ${r.files} files read, ${r.msgs} messages, ${r.skipped} unchanged, ${
            (r.bytes / 1e6).toFixed(1)
          } MB read (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${DB_PATH}`,
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
  case "agent":
    Deno.exit(await agentCommand(rest));
    break;
  case "run":
    Deno.exit(await runCommand(rest));
    break;
  case "routine":
    Deno.exit(await routineCommand(rest));
    break;
  case "account":
    Deno.exit(await accountCommand(rest));
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
  doctor  [--probe] [--json|--notify]   verify the setup's invariants, each with a suggested fix; --notify: desktop notification on new failures only;
          --probe: one tiny request per profile, to see that its Claude Code login works
  status  [--json]            versions, updates, repository sync, profiles and what is mounted, running instances
  sync    [--fetch]           align the repository (fetch when stale, ff-only pull on a clean tree)
  mcp     check|sync|warm|health [--probe]   MCP registry to each profile's mcp.json (cli, passed with --mcp-config) and claude_desktop_config.json (desktop, while closed); --probe really starts each server and waits for initialize
  update  [--cli|--desktop|--codex|--self|--auto|--check [--json]|--rollback [--desktop]]   update Claude Code, Claude Desktop and agents-multi itself (--auto: what the timer runs)
  self-update [--check [--json]] [--settle] [--quiet]   agents-multi itself: ff-only pull on a clean tree, then restarts what runs old code and installs (with Claude closed)
  codex   <profile> [args…] | limits <profile>   Codex (OpenAI) with a profile's own account (login: agents codex <profile> login); its usage windows
  limits  [--json]            every account's usage windows (5h, 7d…): Claude's from the status line, Codex's from its logs
  usage   [ingest [--full]] [--by profile|model|project|agent|day|session|entrypoint|skill|command]
          [--since 30d|7d|all|YYYY-MM-DD] [--profile p] [--limit n] [--no-ingest] [--json]
  vault   [status|init|pair|recovery-code|set|delete|run]   the MCP servers' secrets: encrypted,
          in ~/vault/claude-multi (Syncthing), key in this machine's keyring
  google  client <file.json> | connect <account>   the Google OAuth client, and connecting an account
  tasks   [brief|add|done|remind]   the task list (in the brain); remind is what claude-tasks.timer runs
  agent   start|list|status|say|answer|stop|wait|events   Claude sessions of any profile at work in a project, every
          permission they need answered here (agents agent, alone, says how)
  run     start|list|status|answer|resume   workflow runs: a plan of steps, each a child, with HANDOFFs and a
          team channel (agents run, alone, says how)
  routine add|list|rm|run   unattended jobs (cron, at, a run's end) on their own branch, under the repo's policy
  account status|default|proposals|propose|accept|decline|events   the limit rules per account, a project's default account, and the owner's yes to a switch
  brain-login [account]       sign this machine in to the brain: token and backup key into the vault, nothing to copy
  brain-backup [--force]      a sealed copy of the brain here, only when it changed (claude-brain-backup.timer)
  ui      build               build the console's interface (apps/ui, pnpm) that serve shows
  gateway [status|run]        the lazy MCP gateway (docs/adr/0008): status, or run it in the foreground (the console keeps it up)
  serve   [--no-open]         local console on http://127.0.0.1:${PORT} (today, connections, profiles, plugins, updates, health)
  version                     the version of agents-multi (also --version, -V)

  agents-multi and claude-multi are other names for the same command (the second is the project's name before Agents Multi).

  The desktop app serves the console and starts at login in the tray; without it (a headless box),
  agents serve runs it by hand.`);
    if (!["help", "--help", "-h"].includes(cmd)) Deno.exit(2);
}
