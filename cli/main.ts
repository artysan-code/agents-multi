#!/usr/bin/env -S deno run --quiet --allow-read --allow-write --allow-run --allow-env --allow-sys=hostname --allow-net=127.0.0.1:8384,127.0.0.1:7331
// claude-multi — CLI for a multi-profile Claude Code / Claude Desktop setup.
//
//   install [--dry-run]     materialise ~/.claude-multi, ~/.local/bin, units and .desktop entries (idempotent)
//   settings [--dry-run] [--quiet]   regenerate each profile's settings.json, adopting what Claude wrote into it
//   doctor  [--json|--notify [--dry-run]]   verify every invariant; --notify raises a desktop notification on new failures only
//   status  [--json]        versions, updates, repo sync, profiles (what is mounted), running instances
//   sync    [--fetch]       align the repository (fetch when stale, ff-only pull on a clean tree)
//   mcp     check|sync|health [--force]   MCP registry to .claude.json (cli) and claude_desktop_config.json (desktop)
//   update  [...]           passthrough to bin/claude-update (CLI + Desktop, --rollback)
//   usage   [...]           tokens and list-price estimate per profile/model/project/agent/skill/command (SQLite)
//   serve   [--no-open]     local console on http://127.0.0.1:7331 (today, connections, profiles, plugins, updates, health)
//   tasks   [...]           the task list, its brief and the desktop reminders
//   vault   [...]           the MCP servers' secrets: encrypted in ~/vault/claude-multi, key in the keyring
//
// Principle: the repository is the source of truth, ~/.claude-multi is runtime materialised by
// `install`. Launching Claude stays pure bash (bin/claude, the per-profile launchers, bin/lib/prelaunch.sh):
// management lives here. Zero external dependencies — Deno APIs plus the built-in node:sqlite — so
// it runs on a fresh machine with no cache to warm.

import { vaultCommand } from "./vault.ts";
import { tasksCommand } from "./tasks.ts";
import { googleCommand } from "./google.ts";
import { ANSI, CACHE, printDoctor, readJson, REPO, run } from "./lib.ts";
import { doctor } from "./doctor.ts";
import { notifyDoctor } from "./notify.ts";
import { install } from "./install.ts";
import { syncAllSettings } from "./settings.ts";
import { printStatus, status } from "./status.ts";
import { apply, blockers, describe, health, plan } from "./mcp.ts";
import { DB_PATH, type GroupBy, ingest, openDb, printReport, report } from "./usage.ts";
import { PORT, serve } from "./serve.ts";

const [cmd = "help", ...rest] = Deno.args;
const flag = (f: string) => rest.includes(f);
const opt = (name: string, def?: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def; };

switch (cmd) {
  case "install": Deno.exit(await install(flag("--dry-run"))); break;
  case "settings": {
    const dry = flag("--dry-run");
    for (const r of await syncAllSettings({ dry })) {
      const pre = dry ? `${ANSI.d}(dry)${ANSI.x} ` : "";
      if (r.adopted.length) console.log(`  ${pre}${r.profile}: adopted into profiles/${r.profile}/settings.json: ${r.adopted.join(", ")}`);
      if (r.orphan) console.log(`  ${pre}${r.profile}: settings.json had no record of being generated, kept aside as ${r.orphan}`);
      if (r.wrote && !flag("--quiet")) console.log(`  ${pre}${r.profile}/settings.json ${r.migrated ? "generated (was a link to shared/)" : "regenerated"}`);
    }
    break;
  }
  case "doctor": {
    const c = await doctor();
    if (flag("--notify")) { const sent = await notifyDoctor(c, { dryRun: flag("--dry-run") }); console.log(sent ? "notification sent" : "nothing new, no notification"); break; }
    if (flag("--json")) console.log(JSON.stringify(c, null, 2)); else Deno.exit(printDoctor(c));
    break;
  }
  case "status": {
    const s = await status();
    if (flag("--json")) console.log(JSON.stringify(s, null, 2)); else { printStatus(s); printDoctor(s.doctor); }
    break;
  }
  case "sync": {
    const env: Record<string, string> = flag("--fetch") ? { CLAUDE_MULTI_FETCH_TTL: "0", CLAUDE_MULTI_FETCH_TIMEOUT: "15" } : {};
    const r = await run("bash", [`${REPO}/bin/lib/prelaunch.sh`], { env });
    if (r.err) console.error(r.err);
    const st = await readJson(`${CACHE}/sync.json`) as Record<string, unknown> | null;
    if (st) console.log(`repo ${st.upstream ? "" : "(no upstream) "}↓${st.behind} ↑${st.ahead} ✎${st.dirty}${st.pulled ? `  pulled +${st.pulled}` : ""}${st.fetch_ok ? "" : "  (fetch failed: offline?)"}`);
    else console.log("no sync state (repository without .git?)");
    break;
  }
  case "mcp": {
    const sub = rest[0] ?? "check";
    if (sub === "health") { Deno.exit(printDoctor(await health({ live: flag("--probe") }))); }
    const { changes, skipped } = await plan();
    for (const t of skipped) console.log(`  ${ANSI.d}skipping ${t.managedKey}: ${t.path} is missing${ANSI.x}`);
    if (!changes.length) { console.log("MCP registry already applied on every surface"); break; }
    for (const c of changes) console.log(`  ${describe(c)}`);
    if (sub === "check" || flag("--dry-run")) { console.log(`\n${changes.length} pending changes → claude-multi mcp sync (with Claude closed)`); Deno.exit(1); }
    if (sub !== "sync") { console.error(`mcp: unknown subcommand "${sub}" (check|sync|health)`); Deno.exit(2); }
    try {
      await apply({ force: flag("--force") });
      console.log(`\n${changes.length} changes applied. Restart the affected Claude instances to load them.`);
    } catch (e) {
      console.error(`\n! ${(e as Error).message}`);
      const b = await blockers(); if (Object.keys(b).length) console.error(`  running: ${JSON.stringify(b)}`);
      Deno.exit(2);
    }
    break;
  }
  case "update": {
    const p = new Deno.Command(`${REPO}/bin/claude-update`, { args: rest, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    Deno.exit((await p.output()).code);
    break;
  }
  case "usage": {
    const db = openDb();
    if (rest[0] === "ingest" || !flag("--no-ingest")) {
      const t0 = Date.now();
      const r = await ingest(db, { full: flag("--full") });
      if (rest[0] === "ingest" || r.files) console.error(`ingest: ${r.files} files read, ${r.msgs} messages, ${r.skipped} unchanged (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${DB_PATH}`);
      if (rest[0] === "ingest") break;
    }
    const rep = report(db, { by: opt("--by", "profile") as GroupBy, since: opt("--since", "30d"), profile: opt("--profile"), limit: Number(opt("--limit", "40")) });
    if (flag("--json")) console.log(JSON.stringify(rep, null, 2)); else printReport(rep);
    break;
  }
  case "serve": await serve({ open: !flag("--no-open") }); break;
  case "vault": Deno.exit(await vaultCommand(rest)); break;
  case "tasks": Deno.exit(await tasksCommand(rest)); break;
  case "google": Deno.exit(await googleCommand(rest)); break;
  case "help": case "--help": case "-h":
  default:
    console.log(`claude-multi — manage a multi-profile Claude setup (repository ${REPO})

  install [--dry-run]         materialise runtime, wrappers, units and desktop entries (idempotent)
  doctor  [--json|--notify]   verify the setup's invariants, each with a suggested fix; --notify: desktop notification on new failures only
  status  [--json]            versions, updates, repository sync, profiles and what is mounted, running instances
  sync    [--fetch]           align the repository (fetch when stale, ff-only pull on a clean tree)
  mcp     check|sync|health [--probe]   MCP registry to .claude.json (cli) and claude_desktop_config.json (desktop); --force ignores running instances; --probe really starts each server and waits for initialize
  update  [--cli|--desktop|--auto|--check [--json]|--rollback [--desktop]]   update Claude Code / Claude Desktop (--auto: what the timer runs)
  usage   [ingest [--full]] [--by profile|model|project|agent|day|session|entrypoint|skill|command]
          [--since 30d|7d|all|YYYY-MM-DD] [--profile p] [--limit n] [--no-ingest] [--json]
  vault   [status|init|pair|recovery-code|set|delete|import-legacy]   the MCP servers' secrets: encrypted,
          in ~/vault/claude-multi (Syncthing), key in this machine's keyring
  google  client <file.json> | connect <account>   the Google OAuth client, and connecting an account
  tasks   [brief|add|done|remind|migrate]   the task list (in the brain); remind is what claude-tasks.timer runs
  serve   [--no-open]         local console on http://127.0.0.1:${PORT} (today, connections, profiles, plugins, updates, health)

  The console runs as a systemd user unit after install, so it is always there:
  systemctl --user status claude-multi-console.service`);
    if (!["help", "--help", "-h"].includes(cmd)) Deno.exit(2);
}
