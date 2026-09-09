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
// confrontare profili, modelli e giornate, non per la contabilità. Chi paga davvero, e quando una
// soglia ha senso, lo decide budget.ts leggendo lo stato crediti del profilo.
//
// Attribuzione a skill e comandi: una skill non consuma token da sola, li fa consumare al turno che
// la usa. Il turno è l'unità ben definita che abbiamo (dal prompt umano al successivo), quindi il
// costo del turno si divide in parti uguali fra le skill/comandi che vi compaiono: `uses` conta le
// invocazioni, `costo` è la quota. Approssimazione dichiarata, non una misura diretta.

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
export function openDb(path: string = DB_PATH) {
  if (path !== ":memory:") Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const db = new DatabaseSync(path);
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
      cost_usd REAL, cwd TEXT, entrypoint TEXT, version TEXT, turn_id TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_profile_day ON messages(profile, day);
    CREATE INDEX IF NOT EXISTS messages_file ON messages(file);
    CREATE TABLE IF NOT EXISTS agent_spawns (
      tool_use_id TEXT PRIMARY KEY, profile TEXT, project TEXT, session_id TEXT, ts TEXT, day TEXT,
      subagent_type TEXT, description TEXT, model TEXT
    );
    CREATE TABLE IF NOT EXISTS turn_tools (
      turn_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      profile TEXT, project TEXT, session_id TEXT, file TEXT, ts TEXT, day TEXT,
      PRIMARY KEY (turn_id, kind, name)
    );
    CREATE INDEX IF NOT EXISTS turn_tools_kind ON turn_tools(kind, name);
    CREATE INDEX IF NOT EXISTS turn_tools_file ON turn_tools(file);
    CREATE TABLE IF NOT EXISTS credit_samples (
      profile TEXT NOT NULL, fetched_at TEXT NOT NULL, seen_at TEXT NOT NULL, day TEXT NOT NULL,
      enabled INTEGER, used_credits REAL, monthly_limit REAL, currency TEXT, decimals INTEGER,
      utilization REAL, plan_json TEXT,
      PRIMARY KEY (profile, fetched_at)
    );
  `);
  // migrazione: DB creati prima dell'attribuzione per turno non hanno la colonna
  const cols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("turn_id")) db.exec("ALTER TABLE messages ADD COLUMN turn_id TEXT");
  return db;
}

// ---------------------------------------------------------------- ingest
interface Acc { input: number; output: number; cacheRead: number; cache5m: number; cache1h: number; model: string; ts: string; sidechain: boolean; agentId: string | null; agent: string; cwd: string | null; entrypoint: string | null; version: string | null; sessionId: string | null; turnId: string | null }

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
  const base = `${RUNTIME}/${profile}/projects/`;
  if (!path.startsWith(base)) return null;
  return path.slice(base.length).split("/")[0] ?? null;
}

export async function ingestFile(db: DatabaseSync, profile: string, path: string) {
  const text = await Deno.readTextFile(path);
  const project = projectOf(path, profile);
  const inSub = path.includes("/subagents/");
  const msgs = new Map<string, Acc>();
  const spawns: { id: string; ts: string; type: string; desc: string; model: string; session: string | null }[] = [];
  // turno = dal prompt umano al successivo. Serve ad attribuire il costo a skill e comandi slash.
  let turnId: string | null = null, turnUsed = false;
  const tools = new Map<string, { turn: string; kind: string; name: string; ts: string; session: string | null }>();
  const rememberTool = (kind: string, name: string, ts: string, session: string | null) => {
    if (!turnId || !name) return;
    const k = `${turnId}|${kind}|${name}`;
    if (!tools.has(k)) tools.set(k, { turn: turnId, kind, name, ts, session });
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === "user" && !d.isSidechain && !inSub) {
      // un tool_result è la continuazione del turno, non un prompt nuovo
      const c = (d.message as { content?: unknown } | undefined)?.content;
      const isToolResult = Array.isArray(c) && c.some((b) => (b as { type?: string }).type === "tool_result");
      if (isToolResult) continue;
      // prompt consecutivi senza risposta in mezzo (un comando slash è seguito dalla sua espansione)
      // sono lo stesso turno: cambiare qui lascerebbe il comando su un turno senza costo
      if (turnUsed || !turnId) { turnId = (d.uuid as string) ?? turnId; turnUsed = false; }
      const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("\n") : "";
      const ts = String(d.timestamp ?? ""), sess = (d.sessionId as string) ?? null;
      for (const m of txt.matchAll(/<command-name>\s*([^<]+?)\s*<\/command-name>/g)) rememberTool("command", m[1].replace(/^\//, ""), ts, sess);
      continue;
    }
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
      sessionId: (d.sessionId as string) ?? null, turnId,
    };
    turnUsed = true;
    const prev = msgs.get(m.id);
    if (prev) { // chunk della stessa risposta: tieni il massimo per campo
      prev.input = Math.max(prev.input, cur.input); prev.output = Math.max(prev.output, cur.output);
      prev.cacheRead = Math.max(prev.cacheRead, cur.cacheRead); prev.cache5m = Math.max(prev.cache5m, cur.cache5m); prev.cache1h = Math.max(prev.cache1h, cur.cache1h);
    } else msgs.set(m.id, cur);
    for (const b of m.content ?? []) {
      const blk = b as { type?: string; name?: string; id?: string; input?: { subagent_type?: string; description?: string; skill?: string } };
      if (blk.type !== "tool_use") continue;
      if ((blk.name === "Agent" || blk.name === "Task") && blk.id) {
        spawns.push({ id: blk.id, ts: cur.ts, type: blk.input?.subagent_type ?? "general-purpose", desc: blk.input?.description ?? "", model: m.model, session: cur.sessionId });
      }
      if (blk.name === "Skill" && blk.input?.skill) rememberTool("skill", blk.input.skill, cur.ts, cur.sessionId);
    }
  }
  db.prepare("DELETE FROM messages WHERE file = ?").run(path);
  db.prepare("DELETE FROM turn_tools WHERE file = ?").run(path);
  const ins = db.prepare(`INSERT OR REPLACE INTO messages
    (msg_id, profile, project, session_id, file, sidechain, agent_id, agent, model, ts, day, input, output, cache_read, cache_5m, cache_1h, cost_usd, cwd, entrypoint, version, turn_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [id, a] of msgs) {
    ins.run(id, profile, project, a.sessionId, path, a.sidechain ? 1 : 0, a.agentId, a.agent, a.model, a.ts, a.ts.slice(0, 10),
      a.input, a.output, a.cacheRead, a.cache5m, a.cache1h, costUsd(a.model, a), a.cwd, a.entrypoint, a.version, a.turnId);
  }
  const insT = db.prepare(`INSERT OR REPLACE INTO turn_tools (turn_id, kind, name, profile, project, session_id, file, ts, day) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const t of tools.values()) insT.run(t.turn, t.kind, t.name, profile, project, t.session, path, t.ts, t.ts.slice(0, 10));
  const insS = db.prepare(`INSERT OR REPLACE INTO agent_spawns (tool_use_id, profile, project, session_id, ts, day, subagent_type, description, model) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const s of spawns) insS.run(s.id, profile, project, s.session, s.ts, s.ts.slice(0, 10), s.type, s.desc, s.model);
  return msgs.size;
}

/** Versione dello schema derivato: se sale, i file già letti vanno riletti (i dati derivati cambiano). */
const SCHEMA_VERSION = 2;

export async function ingest(db: DatabaseSync, opts: { full?: boolean; quiet?: boolean } = {}) {
  const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
  const full = opts.full || ver < SCHEMA_VERSION;
  if (full && ver < SCHEMA_VERSION && !opts.quiet) console.error(`schema usage ${ver} → ${SCHEMA_VERSION}: rilettura completa dei transcript`);
  const known = new Map<string, { size: number; mtime: number }>();
  if (!full) for (const r of db.prepare("SELECT path, size, mtime FROM files").all() as { path: string; size: number; mtime: number }[]) known.set(r.path, r);
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
      db.prepare("DELETE FROM messages WHERE file = ?").run(p); db.prepare("DELETE FROM turn_tools WHERE file = ?").run(p);
      db.prepare("DELETE FROM files WHERE path = ?").run(p);
    }
  }
  if (ver < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return { files, msgs, skipped };
}

// ---------------------------------------------------------------- report
export type GroupBy = "profile" | "model" | "project" | "agent" | "day" | "session" | "entrypoint" | "skill" | "command";
// skill e command non sono colonne di `messages`: passano da toolReport()
const GROUP_COL: Record<Exclude<GroupBy, "skill" | "command">, string> = { profile: "profile", model: "model", project: "project", agent: "agent", day: "day", session: "session_id", entrypoint: "entrypoint" };

export function sinceDate(spec: string | undefined): string | null {
  if (!spec || spec === "all") return null;
  const m = spec.match(/^(\d+)d$/);
  if (m) { const d = new Date(); d.setUTCDate(d.getUTCDate() - Number(m[1])); return d.toISOString().slice(0, 10); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  throw new Error(`--since non valido: ${spec} (usa 7d, 30d, all, YYYY-MM-DD)`);
}

/** Skill e comandi slash: il costo del turno diviso fra i tool che vi compaiono (vedi intestazione). */
function toolReport(db: DatabaseSync, kind: "skill" | "command", opts: { since?: string; profile?: string; limit?: number }) {
  const filters: string[] = []; const args: (string | number)[] = [];
  const since = sinceDate(opts.since);
  if (since) { filters.push("m.day >= ?"); args.push(since); }
  if (opts.profile) { filters.push("m.profile = ?"); args.push(opts.profile); }
  const w = ["m.turn_id IS NOT NULL", ...filters].join(" AND ");
  const wOrphan = ["m.turn_id IS NULL", ...filters].join(" AND ");
  const rows = db.prepare(`
    WITH t AS (
      SELECT turn_id, COUNT(*) AS msgs, COUNT(DISTINCT session_id) AS sessions,
        SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_5m + cache_1h) AS cache_write,
        SUM(cost_usd) AS cost, SUM(cost_usd IS NULL) AS unpriced
      FROM messages m WHERE ${w} GROUP BY turn_id
    ), n AS (SELECT turn_id, COUNT(*) AS k FROM turn_tools WHERE kind = ? GROUP BY turn_id)
    SELECT tt.name AS key, COUNT(DISTINCT tt.turn_id) AS uses, COUNT(DISTINCT tt.session_id) AS sessions,
      -- *1.0: in SQLite la divisione fra interi tronca, e i token per skill uscivano sottostimati
      SUM(t.msgs) AS msgs, SUM(t.input * 1.0 / n.k) AS input, SUM(t.output * 1.0 / n.k) AS output,
      SUM(t.cache_read * 1.0 / n.k) AS cache_read, SUM(t.cache_write * 1.0 / n.k) AS cache_write,
      SUM(t.cost / n.k) AS cost, SUM(t.unpriced) AS unpriced
    FROM turn_tools tt JOIN t ON t.turn_id = tt.turn_id JOIN n ON n.turn_id = tt.turn_id
    WHERE tt.kind = ? GROUP BY key ORDER BY cost DESC NULLS LAST, uses DESC LIMIT ?`)
    .all(...args, kind, kind, opts.limit ?? 40) as unknown as Row[];
  const total = rows.reduce((a, x) => ({
    msgs: a.msgs + x.msgs, input: a.input + x.input, output: a.output + x.output,
    cache_read: a.cache_read + x.cache_read, cache_write: a.cache_write + x.cache_write, cost: (a.cost ?? 0) + (x.cost ?? 0),
  }), { msgs: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 as number | null });
  const orphan = db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${wOrphan}`).get(...args) as { n: number } | undefined;
  return { by: kind as GroupBy, split: null, since, profile: opts.profile ?? null, rows, total, spawns: [] as { key: string; n: number }[], orphanMsgs: orphan?.n ?? 0 };
}

interface Row { key: string; day?: string; profile?: string; uses?: number; msgs: number; sessions: number; input: number; output: number; cache_read: number; cache_write: number; cost: number | null; unpriced: number }

export function report(db: DatabaseSync, opts: { by: GroupBy; since?: string; profile?: string; limit?: number; split?: GroupBy }) {
  if (opts.by === "skill" || opts.by === "command") return toolReport(db, opts.by, opts);
  const where: string[] = []; const args: (string | number)[] = [];
  const since = sinceDate(opts.since);
  if (since) { where.push("day >= ?"); args.push(since); }
  if (opts.profile) { where.push("profile = ?"); args.push(opts.profile); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const col = GROUP_COL[opts.by as Exclude<GroupBy, "skill" | "command">];
  // split: seconda dimensione (es. by=day, split=profile → una riga per giorno e profilo, per i grafici impilati)
  const scol = opts.split && opts.split !== opts.by ? GROUP_COL[opts.split as Exclude<GroupBy, "skill" | "command">] : null;
  const rows = db.prepare(`
    SELECT COALESCE(${col}, '—') AS key, ${scol ? `COALESCE(${scol}, '—') AS ${opts.split},` : ""} ${opts.by !== "day" ? "" : "day,"} COUNT(*) AS msgs, COUNT(DISTINCT session_id) AS sessions,
      SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_5m + cache_1h) AS cache_write,
      SUM(cost_usd) AS cost, SUM(cost_usd IS NULL) AS unpriced
    FROM messages ${w} GROUP BY key${scol ? `, ${opts.split}` : ""} ORDER BY ${opts.by === "day" ? "key ASC" : "cost DESC NULLS LAST, output DESC"} LIMIT ?`).all(...args, opts.limit ?? 40) as unknown as Row[];
  const total = db.prepare(`SELECT COUNT(*) AS msgs, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_5m + cache_1h) AS cache_write, SUM(cost_usd) AS cost FROM messages ${w}`).get(...args) as
    { msgs: number; input: number; output: number; cache_read: number; cache_write: number; cost: number | null };
  const spawns = db.prepare(`SELECT subagent_type AS key, COUNT(*) AS n FROM agent_spawns ${w} GROUP BY key ORDER BY n DESC`).all(...args) as { key: string; n: number }[];
  return { by: opts.by, split: opts.split ?? null, since, profile: opts.profile ?? null, rows, total, spawns, orphanMsgs: 0 };
}

/** Sessioni recenti: una riga per session_id con cartella, finestra temporale, messaggi, modelli e costo. */
export function sessions(db: DatabaseSync, opts: { since?: string; profile?: string; limit?: number } = {}) {
  const where: string[] = ["session_id IS NOT NULL"]; const args: (string | number)[] = [];
  const since = sinceDate(opts.since ?? "7d");
  if (since) { where.push("day >= ?"); args.push(since); }
  if (opts.profile) { where.push("profile = ?"); args.push(opts.profile); }
  const rows = db.prepare(`
    SELECT session_id, profile, MAX(cwd) AS cwd, MAX(entrypoint) AS entrypoint, MIN(ts) AS started, MAX(ts) AS ended,
      COUNT(*) AS msgs, SUM(sidechain) AS sidechain_msgs, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cost_usd) AS cost,
      GROUP_CONCAT(DISTINCT model) AS models, GROUP_CONCAT(DISTINCT agent) AS agents
    FROM messages WHERE ${where.join(" AND ")} GROUP BY session_id ORDER BY ended DESC LIMIT ?`).all(...args, opts.limit ?? 50) as
    { session_id: string; profile: string; cwd: string | null; entrypoint: string | null; started: string; ended: string; msgs: number; sidechain_msgs: number; output: number; cache_read: number; cost: number | null; models: string; agents: string }[];
  return rows.map((r) => ({ ...r, models: r.models.split(","), agents: r.agents.split(","), minutes: Math.max(0, Math.round((new Date(r.ended).getTime() - new Date(r.started).getTime()) / 60000)) }));
}

const fmt = (n: number | null | undefined) => n == null ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n);
const usd = (n: number | null | undefined) => n == null ? "—" : `$${n.toFixed(2)}`;

export function printReport(r: ReturnType<typeof report>) {
  const B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";
  console.log(`${B}claude-multi usage${X} — per ${r.by}${r.since ? ` dal ${r.since}` : ""}${r.profile ? ` · profilo ${r.profile}` : ""}  ${D}(costo = equivalente API a listino)${X}`);
  const byTool = r.by === "skill" || r.by === "command";
  const head = ["", ...(byTool ? ["usi"] : []), "msg", "sess", "input", "output", "cache rd", "cache wr", "costo"];
  const w = [Math.max(10, ...r.rows.map((x) => String(x.key).length), 8), ...(byTool ? [5] : []), 6, 5, 8, 8, 9, 9, 9];
  const line = (cells: (string | number)[]) => "  " + cells.map((c, i) => i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i])).join(" ");
  console.log(D + line(head) + X);
  for (const x of r.rows) console.log(line([x.key.length > 48 ? x.key.slice(0, 47) + "…" : x.key, ...(byTool ? [x.uses ?? 0] : []), x.msgs, x.sessions, fmt(Math.round(x.input)), fmt(Math.round(x.output)), fmt(Math.round(x.cache_read)), fmt(Math.round(x.cache_write)), usd(x.cost) + (x.unpriced ? "*" : "")]));
  console.log(B + line(["totale", ...(byTool ? [""] : []), r.total.msgs ?? 0, "", fmt(Math.round(r.total.input)), fmt(Math.round(r.total.output)), fmt(Math.round(r.total.cache_read)), fmt(Math.round(r.total.cache_write)), usd(r.total.cost)]) + X);
  if (byTool) console.log(`  ${D}costo = quota del turno (diviso fra le ${r.by === "skill" ? "skill" : "voci"} dello stesso turno); «msg» = messaggi dei turni coinvolti${r.orphanMsgs ? `; ${r.orphanMsgs} messaggi fuori turno esclusi` : ""}${X}`);
  if (r.rows.some((x) => x.unpriced)) console.log(`  ${D}* modello senza tariffa in tabella: costo parziale${X}`);
  if (r.spawns.length) console.log(`  ${D}subagent lanciati (Agent tool):${X} ${r.spawns.map((s) => `${s.key} ×${s.n}`).join(" · ")}`);
}
