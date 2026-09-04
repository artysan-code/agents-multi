// usage.ts — conteggio token e costo-equivalente per profilo / modello / progetto / agente.
//
// Sorgente: i transcript JSONL di Claude Code (~/.claude-multi/<profilo>/projects/**).
// Ogni riga `assistant` porta `message.usage` (input, output, cache read, cache write 5m/1h) e
// `message.model`. Le righe con lo stesso `message.id` sono chunk della stessa risposta: si
// contano una volta sola. I subagent stanno in <sessione>/subagents/**/agent-*.jsonl e nelle righe
// con `isSidechain`; `attributionAgent` (es. "workflow-subagent") li etichetta quando c'è.
//
// DB: SQLite via node:sqlite (built-in di Deno, zero dipendenze), per-macchina in XDG data.
// Ingest incrementale: un file viene riletto solo se cambia size o mtime.
//
// I costi sono l'EQUIVALENTE API a listino (abbonamento Max → non fatturati a token): servono per
// confrontare profili, modelli e giornate, non per la contabilità.

import { DatabaseSync } from "node:sqlite";

const HOME = Deno.env.get("HOME") ?? "";
const RUNTIME = Deno.env.get("CLAUDE_MULTI_ROOT") ?? `${HOME}/.claude-multi`;
const DATA = `${Deno.env.get("XDG_DATA_HOME") ?? `${HOME}/.local/share`}/claude-multi`;
export const DB_PATH = `${DATA}/usage.db`;
const PROFILES = ["personal", "work"];

// Listino Anthropic (skill claude-api, cache 2026-06-24), $/MTok. Cache: read 0.1×, write 5m 1.25×,
// write 1h 2× dell'input, salvo Fable 5/5.1 (read a 0.25 flat).
interface Rate { input: number; output: number; read?: number }
const RATES: [RegExp, Rate][] = [
  [/fable-5|mythos-5/, { input: 10, output: 50, read: 0.25 }],
  [/opus-5|opus-4-[5678]/, { input: 5, output: 25 }],
  [/opus-4/, { input: 15, output: 75 }],
  [/sonnet-5/, { input: 2, output: 10 }],
  [/sonnet-4/, { input: 3, output: 15 }],
  [/haiku-4-5/, { input: 1, output: 5 }],
  [/haiku-3-5/, { input: 0.8, output: 4 }],
];
function rateFor(model: string): Rate | null {
  for (const [re, r] of RATES) if (re.test(model)) return r;
  return null;
}
export function costUsd(model: string, u: { input: number; output: number; cacheRead: number; cache5m: number; cache1h: number }) {
  const r = rateFor(model); if (!r) return null;
  const M = 1_000_000;
  return (u.input * r.input + u.output * r.output + u.cacheRead * (r.read ?? r.input * 0.1) +
    u.cache5m * r.input * 1.25 + u.cache1h * r.input * 2) / M;
}

// ---------------------------------------------------------------- db
export function openDb() {
  Deno.mkdirSync(DATA, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, profile TEXT, size INTEGER, mtime REAL, ingested_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      msg_id TEXT PRIMARY KEY, profile TEXT NOT NULL, project TEXT, session_id TEXT, file TEXT,
      sidechain INTEGER NOT NULL DEFAULT 0, agent_id TEXT, agent TEXT NOT NULL,
      model TEXT NOT NULL, ts TEXT NOT NULL, day TEXT NOT NULL,
      input INTEGER, output INTEGER, cache_read INTEGER, cache_5m INTEGER, cache_1h INTEGER,
      cost_usd REAL, cwd TEXT, entrypoint TEXT, version TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_profile_day ON messages(profile, day);
    CREATE INDEX IF NOT EXISTS messages_file ON messages(file);
    CREATE TABLE IF NOT EXISTS agent_spawns (
      tool_use_id TEXT PRIMARY KEY, profile TEXT, project TEXT, session_id TEXT, ts TEXT, day TEXT,
      subagent_type TEXT, description TEXT, model TEXT
    );
  `);
  return db;
}

// ---------------------------------------------------------------- ingest
interface Acc { input: number; output: number; cacheRead: number; cache5m: number; cache1h: number; model: string; ts: string; sidechain: boolean; agentId: string | null; agent: string; cwd: string | null; entrypoint: string | null; version: string | null; sessionId: string | null }

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[] = [];
  try { for await (const e of Deno.readDir(dir)) entries.push(e); } catch { return; }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile && e.name.endsWith(".jsonl")) yield p;
  }
}

function projectOf(path: string, profile: string) {
  const rel = path.slice(`${RUNTIME}/${profile}/projects/`.length);
  return rel.split("/")[0] ?? null;
}

async function ingestFile(db: DatabaseSync, profile: string, path: string) {
  const text = await Deno.readTextFile(path);
  const project = projectOf(path, profile);
  const inSub = path.includes("/subagents/");
  const msgs = new Map<string, Acc>();
  const spawns: { id: string; ts: string; type: string; desc: string; model: string; session: string | null }[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "assistant") continue;
    const m = d.message as { id?: string; model?: string; usage?: Record<string, unknown>; content?: unknown[] } | undefined;
    if (!m?.usage || !m.id || !m.model || m.model === "<synthetic>") continue;
    const u = m.usage;
    const cc = (u.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined) ?? {};
    const cache5m = cc.ephemeral_5m_input_tokens ?? (cc.ephemeral_1h_input_tokens == null ? Number(u.cache_creation_input_tokens ?? 0) : 0);
    const cache1h = cc.ephemeral_1h_input_tokens ?? 0;
    const sidechain = !!d.isSidechain || inSub;
    const attribution = typeof d.attributionAgent === "string" ? d.attributionAgent : null;
    const agent = attribution ?? (sidechain ? "subagent" : "main");
    const cur: Acc = {
      input: Number(u.input_tokens ?? 0), output: Number(u.output_tokens ?? 0), cacheRead: Number(u.cache_read_input_tokens ?? 0),
      cache5m, cache1h, model: m.model, ts: String(d.timestamp ?? ""), sidechain, agentId: (d.agentId as string) ?? null, agent,
      cwd: (d.cwd as string) ?? null, entrypoint: (d.entrypoint as string) ?? null, version: (d.version as string) ?? null,
      sessionId: (d.sessionId as string) ?? null,
    };
    const prev = msgs.get(m.id);
    if (prev) { // chunk della stessa risposta: tieni il massimo per campo
      prev.input = Math.max(prev.input, cur.input); prev.output = Math.max(prev.output, cur.output);
      prev.cacheRead = Math.max(prev.cacheRead, cur.cacheRead); prev.cache5m = Math.max(prev.cache5m, cur.cache5m); prev.cache1h = Math.max(prev.cache1h, cur.cache1h);
    } else msgs.set(m.id, cur);
    for (const b of m.content ?? []) {
      const blk = b as { type?: string; name?: string; id?: string; input?: { subagent_type?: string; description?: string } };
      if (blk.type === "tool_use" && (blk.name === "Agent" || blk.name === "Task") && blk.id) {
        spawns.push({ id: blk.id, ts: cur.ts, type: blk.input?.subagent_type ?? "general-purpose", desc: blk.input?.description ?? "", model: m.model, session: cur.sessionId });
      }
    }
  }
  const del = db.prepare("DELETE FROM messages WHERE file = ?"); del.run(path);
  const ins = db.prepare(`INSERT OR REPLACE INTO messages
    (msg_id, profile, project, session_id, file, sidechain, agent_id, agent, model, ts, day, input, output, cache_read, cache_5m, cache_1h, cost_usd, cwd, entrypoint, version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [id, a] of msgs) {
    ins.run(id, profile, project, a.sessionId, path, a.sidechain ? 1 : 0, a.agentId, a.agent, a.model, a.ts, a.ts.slice(0, 10),
      a.input, a.output, a.cacheRead, a.cache5m, a.cache1h, costUsd(a.model, a), a.cwd, a.entrypoint, a.version);
  }
  const insS = db.prepare(`INSERT OR REPLACE INTO agent_spawns (tool_use_id, profile, project, session_id, ts, day, subagent_type, description, model) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const s of spawns) insS.run(s.id, profile, project, s.session, s.ts, s.ts.slice(0, 10), s.type, s.desc, s.model);
  return msgs.size;
}

export async function ingest(db: DatabaseSync, opts: { full?: boolean; quiet?: boolean } = {}) {
  const known = new Map<string, { size: number; mtime: number }>();
  if (!opts.full) for (const r of db.prepare("SELECT path, size, mtime FROM files").all() as { path: string; size: number; mtime: number }[]) known.set(r.path, r);
  let files = 0, msgs = 0, skipped = 0;
  const upFile = db.prepare("INSERT OR REPLACE INTO files (path, profile, size, mtime, ingested_at) VALUES (?,?,?,?,?)");
  for (const profile of PROFILES) {
    for await (const path of walk(`${RUNTIME}/${profile}/projects`)) {
      const st = await Deno.stat(path);
      const mtime = st.mtime?.getTime() ?? 0;
      const k = known.get(path);
      if (k && k.size === st.size && k.mtime === mtime) { skipped++; continue; }
      db.exec("BEGIN");
      try {
        msgs += await ingestFile(db, profile, path);
        upFile.run(path, profile, st.size, mtime, new Date().toISOString());
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); if (!opts.quiet) console.error(`  ! ${path}: ${(e as Error).message}`); continue; }
      files++;
    }
  }
  // file spariti (sessioni cancellate): via anche i loro messaggi
  for (const p of known.keys()) {
    try { await Deno.stat(p); } catch {
      db.prepare("DELETE FROM messages WHERE file = ?").run(p); db.prepare("DELETE FROM files WHERE path = ?").run(p);
    }
  }
  return { files, msgs, skipped };
}

// ---------------------------------------------------------------- report
export type GroupBy = "profile" | "model" | "project" | "agent" | "day" | "session" | "entrypoint";
const GROUP_COL: Record<GroupBy, string> = { profile: "profile", model: "model", project: "project", agent: "agent", day: "day", session: "session_id", entrypoint: "entrypoint" };

export function sinceDate(spec: string | undefined): string | null {
  if (!spec || spec === "all") return null;
  const m = spec.match(/^(\d+)d$/);
  if (m) { const d = new Date(); d.setUTCDate(d.getUTCDate() - Number(m[1])); return d.toISOString().slice(0, 10); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  throw new Error(`--since non valido: ${spec} (usa 7d, 30d, all, YYYY-MM-DD)`);
}

export function report(db: DatabaseSync, opts: { by: GroupBy; since?: string; profile?: string; limit?: number; split?: GroupBy }) {
  const where: string[] = []; const args: (string | number)[] = [];
  const since = sinceDate(opts.since);
  if (since) { where.push("day >= ?"); args.push(since); }
  if (opts.profile) { where.push("profile = ?"); args.push(opts.profile); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const col = GROUP_COL[opts.by];
  // split: seconda dimensione (es. by=day, split=profile → una riga per giorno e profilo, per i grafici impilati)
  const scol = opts.split && opts.split !== opts.by ? GROUP_COL[opts.split] : null;
  const rows = db.prepare(`
    SELECT COALESCE(${col}, '—') AS key, ${scol ? `COALESCE(${scol}, '—') AS ${opts.split},` : ""} ${opts.by !== "day" ? "" : "day,"} COUNT(*) AS msgs, COUNT(DISTINCT session_id) AS sessions,
      SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_5m + cache_1h) AS cache_write,
      SUM(cost_usd) AS cost, SUM(cost_usd IS NULL) AS unpriced
    FROM messages ${w} GROUP BY key${scol ? `, ${opts.split}` : ""} ORDER BY ${opts.by === "day" ? "key ASC" : "cost DESC NULLS LAST, output DESC"} LIMIT ?`).all(...args, opts.limit ?? 40) as
    { key: string; day?: string; profile?: string; msgs: number; sessions: number; input: number; output: number; cache_read: number; cache_write: number; cost: number | null; unpriced: number }[];
  const total = db.prepare(`SELECT COUNT(*) AS msgs, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_5m + cache_1h) AS cache_write, SUM(cost_usd) AS cost FROM messages ${w}`).get(...args) as
    { msgs: number; input: number; output: number; cache_read: number; cache_write: number; cost: number | null };
  const spawns = db.prepare(`SELECT subagent_type AS key, COUNT(*) AS n FROM agent_spawns ${w} GROUP BY key ORDER BY n DESC`).all(...args) as { key: string; n: number }[];
  return { by: opts.by, split: opts.split ?? null, since, profile: opts.profile ?? null, rows, total, spawns };
}

const fmt = (n: number | null | undefined) => n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
const usd = (n: number | null | undefined) => n == null ? "—" : `$${n.toFixed(2)}`;

export function printReport(r: ReturnType<typeof report>) {
  const B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";
  console.log(`${B}claude-multi usage${X} — per ${r.by}${r.since ? ` dal ${r.since}` : ""}${r.profile ? ` · profilo ${r.profile}` : ""}  ${D}(costo = equivalente API a listino)${X}`);
  const head = ["", "msg", "sess", "input", "output", "cache rd", "cache wr", "costo"];
  const w = [Math.max(10, ...r.rows.map((x) => String(x.key).length), 8), 6, 5, 8, 8, 9, 9, 9];
  const line = (cells: (string | number)[]) => "  " + cells.map((c, i) => i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i])).join(" ");
  console.log(D + line(head) + X);
  for (const x of r.rows) console.log(line([x.key.length > 48 ? x.key.slice(0, 47) + "…" : x.key, x.msgs, x.sessions, fmt(x.input), fmt(x.output), fmt(x.cache_read), fmt(x.cache_write), usd(x.cost) + (x.unpriced ? "*" : "")]));
  console.log(B + line(["totale", r.total.msgs ?? 0, "", fmt(r.total.input), fmt(r.total.output), fmt(r.total.cache_read), fmt(r.total.cache_write), usd(r.total.cost)]) + X);
  if (r.rows.some((x) => x.unpriced)) console.log(`  ${D}* modello senza tariffa in tabella: costo parziale${X}`);
  if (r.spawns.length) console.log(`  ${D}subagent lanciati (Agent tool):${X} ${r.spawns.map((s) => `${s.key} ×${s.n}`).join(" · ")}`);
}
