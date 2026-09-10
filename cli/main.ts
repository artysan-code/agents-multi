#!/usr/bin/env -S deno run --quiet --allow-read --allow-write --allow-run --allow-env --allow-sys=hostname --allow-net=127.0.0.1:8384,127.0.0.1:11434,localhost:11434,127.0.0.1:8090,127.0.0.1:7331
// claude-multi — CLI for a multi-profile Claude Code / Claude Desktop setup.
//
//   install [--dry-run]     materialise ~/.claude-multi, ~/.local/bin, units and .desktop entries (idempotent)
//   doctor  [--json|--notify [--dry-run]]   verify every invariant; --notify raises a desktop notification on new failures only
//   status  [--json]        versions, updates, repo sync, profiles (what is mounted), running instances
//   sync    [--fetch]       align the repository (fetch when stale, ff-only pull on a clean tree)
//   mcp     check|sync|health [--force]   MCP registry to .claude.json (cli) and claude_desktop_config.json (desktop)
//   update  [...]           passthrough to bin/claude-update (CLI + Desktop, --rollback)
//   usage   [...]           tokens and list-price estimate per profile/model/project/agent/skill/command (SQLite)
//   budget  [--notify]      consumption thresholds; alerts on billed extra usage only
//   serve   [--no-open]     local console on http://127.0.0.1:7331 (state, usage, sessions, health, actions)
//
// Principle: the repository is the source of truth, ~/.claude-multi is runtime materialised by
// `install`. Launching Claude stays pure bash (bin/claude, bin/claude-work, bin/lib/prelaunch.sh):
// management lives here. Zero external dependencies — Deno APIs plus the built-in node:sqlite — so
// it runs on a fresh machine with no cache to warm.

import { ANSI, CACHE, printDoctor, readJson, REPO, run } from "./lib.ts";
import { doctor } from "./doctor.ts";
import { notifyDoctor } from "./notify.ts";
import { install } from "./install.ts";
import { printStatus, status } from "./status.ts";
import { apply, blockers, describe, health, plan } from "./mcp.ts";
import { DB_PATH, type GroupBy, ingest, openDb, printReport, report } from "./usage.ts";
import { collect, notifyBudget, printBudget } from "./budget.ts";
import { PORT, serve } from "./serve.ts";

const [cmd = "help", ...rest] = Deno.args;
const flag = (f: string) => rest.includes(f);
const opt = (name: string, def?: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : def; };

switch (cmd) {
  case "install": Deno.exit(await install(flag("--dry-run")));
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
  case "budget": {
    const r = await collect({ ingest: !flag("--no-ingest") });
    if (flag("--notify")) { const sent = await notifyBudget(r, { dryRun: flag("--dry-run") }); console.log(sent ? "notification sent" : "nothing worth reporting"); break; }
    if (flag("--json")) console.log(JSON.stringify(r, null, 2)); else printBudget(r);
    break;
  }
  case "serve": await serve({ open: !flag("--no-open") }); break;
  // deno-lint-ignore no-fallthrough
  case "help": case "--help": case "-h":
  default:
    console.log(`claude-multi — manage a multi-profile Claude setup (repository ${REPO})

  install [--dry-run]         materialise runtime, wrappers, units and desktop entries (idempotent)
  doctor  [--json|--notify]   verify the setup's invariants, each with a suggested fix; --notify: desktop notification on new failures only
  status  [--json]            versions, updates, repository sync, profiles and what is mounted, running instances
  sync    [--fetch]           align the repository (fetch when stale, ff-only pull on a clean tree)
  mcp     check|sync|health [--probe]   MCP registry to .claude.json (cli) and claude_desktop_config.json (desktop); --force ignores running instances; --probe really starts each server and waits for initialize
  update  [--cli|--desktop|--check [--json]|--rollback]   update Claude Code / Claude Desktop
  usage   [ingest [--full]] [--by profile|model|project|agent|day|session|entrypoint|skill|command]
          [--since 30d|7d|all|YYYY-MM-DD] [--profile p] [--limit n] [--no-ingest] [--json]
  budget  [--notify [--dry-run]] [--json]   consumption thresholds from shared/budget.json. Only billed
          extra usage raises an alert: plan windows and list-price estimates are shown, never notified
  serve   [--no-open]         local console on http://127.0.0.1:${PORT} (state, usage, sessions, health, actions)

  The console runs as a systemd user unit after install, so it is always there:
  systemctl --user status claude-multi-console.service`);
    if (!["help", "--help", "-h"].includes(cmd)) Deno.exit(2);
}
