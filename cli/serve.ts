// serve.ts — dashboard locale: `claude-multi serve` apre http://127.0.0.1:7331.
// Un solo processo, nessun daemon: parte, apre il browser, muore con Ctrl-C. Pagina in cli/dashboard/
// (HTML/CSS/JS senza dipendenze né asset esterni: funziona offline). Dati = status() e usage.ts.
// Azioni (POST /api/action): allowlist di sottocomandi della CLI, solo da localhost, con header
// anti-CSRF `x-claude-multi`. L'update NON è tra le azioni: passa dal gate con polkit.

import { ANSI, CACHE, readText, REPO } from "./lib.ts";
import { status } from "./status.ts";
import { type GroupBy, ingest, openDb, report, sessions } from "./usage.ts";

export const PORT = Number(Deno.env.get("CLAUDE_MULTI_PORT") ?? 7331);
const DASH = `${REPO}/cli/dashboard`;
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

/** Azioni ammesse → argomenti della CLI. `opts` accettate per azione (tutto il resto viene ignorato). */
const ACTIONS: Record<string, { args: string[]; opts?: Record<string, string[]>; timeoutMs?: number }> = {
  "doctor": { args: ["doctor"] },
  "sync-fetch": { args: ["sync", "--fetch"], timeoutMs: 30000 },
  "mcp-check": { args: ["mcp", "check"] },
  "mcp-sync": { args: ["mcp", "sync"], opts: { force: ["--force"] } },
  "install-dry": { args: ["install", "--dry-run"] },
  "install": { args: ["install"] },
  "usage-ingest": { args: ["usage", "ingest", "--full"], timeoutMs: 120000 },
  "update-check": { args: ["update", "--check"], timeoutMs: 40000 },
};

async function runAction(name: string, opts: string[]) {
  const a = ACTIONS[name];
  if (!a) return { code: 2, output: `azione sconosciuta: ${name}`, ms: 0 };
  const extra = (opts ?? []).flatMap((o) => a.opts?.[o] ?? []);
  const t0 = Date.now();
  const cmd = new Deno.Command(`${REPO}/bin/claude-multi`, { args: [...a.args, ...extra], cwd: REPO, stdout: "piped", stderr: "piped", env: { NO_COLOR: "1" } });
  const child = cmd.spawn();
  const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* già finito */ } }, a.timeoutMs ?? 60000);
  const r = await child.output(); clearTimeout(timer);
  const dec = new TextDecoder();
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  let output = strip(dec.decode(r.stdout)); const err = strip(dec.decode(r.stderr)).trim();
  if (err) output += (output ? "\n" : "") + err;
  // update --check ritorna 10 quando c'è un aggiornamento: non è un errore (la cache la scrive il check stesso)
  if (name === "update-check") return { code: r.code === 10 ? 0 : r.code, output: output + (r.code === 10 ? "\n(aggiornamenti disponibili: passa dal gate o da claude-multi update)" : ""), ms: Date.now() - t0 };
  return { code: r.code, output, ms: Date.now() - t0 };
}

export async function serve(opts: { open?: boolean } = { open: true }) {
  const url = `http://127.0.0.1:${PORT}`;
  let cache: { at: number; body: string } | null = null;
  const json = (v: unknown, code = 200) => new Response(JSON.stringify(v), { status: code, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  const handler = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/api/status") {
        if (!cache || u.searchParams.has("fresh") || Date.now() - cache.at > 5000) cache = { at: Date.now(), body: JSON.stringify(await status()) };
        return new Response(cache.body, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      if (u.pathname === "/api/usage") {
        const db = openDb(); await ingest(db, { quiet: true });
        const r = report(db, {
          by: (u.searchParams.get("by") ?? "profile") as GroupBy, since: u.searchParams.get("since") ?? "30d",
          profile: u.searchParams.get("profile") || undefined, limit: Number(u.searchParams.get("limit") ?? 60),
          split: (u.searchParams.get("split") || undefined) as GroupBy | undefined,
        });
        db.close();
        return json(r);
      }
      if (u.pathname === "/api/sessions") {
        const db = openDb(); await ingest(db, { quiet: true });
        const r = sessions(db, { since: u.searchParams.get("since") ?? "7d", profile: u.searchParams.get("profile") || undefined, limit: Number(u.searchParams.get("limit") ?? 60) });
        db.close();
        return json(r);
      }
      if (u.pathname === "/api/sync") return new Response(await readText(`${CACHE}/sync.json`) ?? "null", { headers: { "content-type": "application/json" } });
      if (u.pathname === "/api/action") {
        if (req.method !== "POST") return json({ error: "POST" }, 405);
        if (req.headers.get("x-claude-multi") !== "1") return json({ error: "header mancante" }, 403);
        const body = await req.json().catch(() => ({})) as { action?: string; opts?: string[] };
        const r = await runAction(String(body.action ?? ""), body.opts ?? []);
        cache = null;
        return json(r);
      }
      // statici
      const path = u.pathname === "/" ? "/index.html" : u.pathname;
      if (!/^\/[a-z0-9_.-]+$/i.test(path)) return new Response("not found", { status: 404 });
      const ext = path.slice(path.lastIndexOf("."));
      const body = await readText(`${DASH}${path}`);
      if (body === null || !MIME[ext]) return new Response("not found", { status: 404 });
      return new Response(body, { headers: { "content-type": MIME[ext], "cache-control": "no-cache" } });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  };
  console.log(`${ANSI.b}claude-multi serve${ANSI.x} — ${url}  ${ANSI.d}(Ctrl-C per chiudere; solo localhost)${ANSI.x}`);
  const srv = Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => {} }, handler);
  if (opts.open) { try { new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn().unref(); } catch { /* nessun browser */ } }
  await srv.finished;
}
