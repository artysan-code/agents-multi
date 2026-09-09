#!/usr/bin/env -S deno run --quiet --allow-read --allow-write --allow-run --allow-env --allow-sys=hostname --allow-net=127.0.0.1:8384,127.0.0.1:11434,localhost:11434,127.0.0.1:8090,127.0.0.1:7331
// claude-multi — CLI di gestione del setup multi-profilo di Claude Code / Claude Desktop.
//
//   install [--dry-run]     materializza ~/.claude-multi, ~/.local/bin, unit, .desktop dal repo (idempotente)
//   doctor  [--json|--notify [--dry-run]]   verifica ogni invariante; --notify manda una notifica KDE solo sui fail nuovi (timer)
//   status  [--json]        versioni, update, sync repo, profili (cosa è montato), istanze attive
//   sync    [--fetch]       allinea il repo (fetch se stantio, pull ff-only a tree pulito)
//   mcp     check|sync|health [--force]   registry MCP → .claude.json (cli) e claude_desktop_config.json (desktop)
//   update  [...]           passthrough a bin/claude-update (CLI + Desktop, --rollback)
//   usage   [...]           token e costo-equivalente per profilo/modello/progetto/agente/skill/comando (SQLite)
//   budget  [--notify]      soglie di consumo; notifica solo la spesa reale (extra credits), mai l'abbonamento
//   serve   [--no-open]     dashboard locale su http://127.0.0.1:7331 (stato, usage, sessioni, doctor, azioni sulla CLI)
//
// Principio: il repo è la fonte di verità, ~/.claude-multi è runtime materializzato da `install`.
// Il lancio di Claude resta bash puro (bin/claude, bin/claude-work, bin/lib/prelaunch.sh): qui la gestione.
// Zero dipendenze esterne: solo API Deno (+ node:sqlite built-in), così gira su una macchina nuova senza cache.

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
    if (flag("--notify")) { const sent = await notifyDoctor(c, { dryRun: flag("--dry-run") }); console.log(sent ? "notifica inviata" : "niente di nuovo, nessuna notifica"); break; }
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
    if (st) console.log(`repo ${st.upstream ? "" : "(senza upstream) "}↓${st.behind} ↑${st.ahead} ✎${st.dirty}${st.pulled ? `  pull +${st.pulled}` : ""}${st.fetch_ok ? "" : "  (fetch fallito: offline?)"}`);
    else console.log("nessuno stato di sync (repo senza .git?)");
    break;
  }
  case "mcp": {
    const sub = rest[0] ?? "check";
    if (sub === "health") { Deno.exit(printDoctor(await health({ live: flag("--probe") }))); }
    const { changes, skipped } = await plan();
    for (const t of skipped) console.log(`  ${ANSI.d}salto ${t.managedKey}: ${t.path} assente${ANSI.x}`);
    if (!changes.length) { console.log("registry MCP già applicato su tutte le superfici"); break; }
    for (const c of changes) console.log(`  ${describe(c)}`);
    if (sub === "check" || flag("--dry-run")) { console.log(`\n${changes.length} modifiche pendenti → claude-multi mcp sync (a Claude chiuso)`); Deno.exit(1); }
    if (sub !== "sync") { console.error(`mcp: sottocomando sconosciuto "${sub}" (check|sync|health)`); Deno.exit(2); }
    try {
      await apply({ force: flag("--force") });
      console.log(`\n${changes.length} modifiche applicate. Riavvia le istanze Claude interessate per caricarle.`);
    } catch (e) {
      console.error(`\n! ${(e as Error).message}`);
      const b = await blockers(); if (Object.keys(b).length) console.error(`  attive: ${JSON.stringify(b)}`);
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
      if (rest[0] === "ingest" || r.files) console.error(`ingest: ${r.files} file letti, ${r.msgs} messaggi, ${r.skipped} invariati (${((Date.now() - t0) / 1000).toFixed(1)}s) → ${DB_PATH}`);
      if (rest[0] === "ingest") break;
    }
    const rep = report(db, { by: opt("--by", "profile") as GroupBy, since: opt("--since", "30d"), profile: opt("--profile"), limit: Number(opt("--limit", "40")) });
    if (flag("--json")) console.log(JSON.stringify(rep, null, 2)); else printReport(rep);
    break;
  }
  case "budget": {
    const r = await collect({ ingest: !flag("--no-ingest") });
    if (flag("--notify")) { const sent = await notifyBudget(r, { dryRun: flag("--dry-run") }); console.log(sent ? "notifica inviata" : "niente da segnalare"); break; }
    if (flag("--json")) console.log(JSON.stringify(r, null, 2)); else printBudget(r);
    break;
  }
  case "serve": await serve({ open: !flag("--no-open") }); break;
  // deno-lint-ignore no-fallthrough
  case "help": case "--help": case "-h":
  default:
    console.log(`claude-multi — gestione del setup multi-profilo Claude (repo ${REPO})

  install [--dry-run]         materializza runtime, wrapper, unit e .desktop dal repo (idempotente)
  doctor  [--json|--notify]   verifica le invarianti del setup, con fix suggerito; --notify: notifica KDE solo sui fail nuovi
  status  [--json]            versioni, aggiornamenti, sync repo, profili e cosa è montato, istanze attive
  sync    [--fetch]           allinea il repo (fetch se stantio, pull ff-only a tree pulito)
  mcp     check|sync|health [--probe]   registry MCP → .claude.json (cli) e claude_desktop_config.json (desktop); --force ignora le istanze attive; --probe avvia davvero ogni server e attende initialize
  update  [--cli|--desktop|--check [--json]|--rollback]   aggiorna Claude Code / Claude Desktop
  usage   [ingest [--full]] [--by profile|model|project|agent|day|session|entrypoint|skill|command]
          [--since 30d|7d|all|YYYY-MM-DD] [--profile p] [--limit n] [--no-ingest] [--json]
  budget  [--notify [--dry-run]] [--json]   soglie di consumo da shared/budget.json; con notify "auto"
          avvisa solo dove si spende davvero (extra credits), non sull'uso incluso nell'abbonamento
  serve   [--no-open]         dashboard locale su http://127.0.0.1:${PORT} (stato, usage, sessioni, doctor, azioni)`);
    if (!["help", "--help", "-h"].includes(cmd)) Deno.exit(2);
}
