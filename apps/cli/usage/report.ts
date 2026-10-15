// usage/report.ts — the database read back: totals by group, per-skill shares, the session list.

import type { DatabaseSync } from "node:sqlite";
import { HOME } from "./db.ts";

/** Readable name for a project. The stored key is the slugified working directory, which is both
 *  unreadable and, in a shared UI, a leak of the directory tree. The recorded `cwd` gives the real
 *  name; the slug is only a fallback, and an ambiguous one — it maps every "/" and "-" to "-". */
export function projectLabel(slug: string | null, cwd?: string | null): string {
  if (cwd) {
    const b = cwd.replace(/\/+$/, "").split("/").pop();
    if (b) return b;
  }
  if (!slug) return "—";
  const home = HOME.replace(/\//g, "-");
  const rest = slug.startsWith(home) ? slug.slice(home.length) : slug;
  return rest.replace(/^-+/, "") || slug;
}

export type GroupBy =
  | "profile"
  | "model"
  | "project"
  | "agent"
  | "day"
  | "session"
  | "entrypoint"
  | "skill"
  | "command";
// skill and command are not columns on `messages`: they go through toolReport()
const GROUP_COL: Record<Exclude<GroupBy, "skill" | "command">, string> = {
  profile: "profile",
  model: "model",
  project: "project",
  agent: "agent",
  day: "day",
  session: "session_id",
  entrypoint: "entrypoint",
};

export function sinceDate(spec: string | undefined): string | null {
  if (!spec || spec === "all") return null;
  const m = spec.match(/^(\d+)d$/);
  if (m) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - Number(m[1]));
    return d.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return spec;
  throw new Error(`invalid --since: ${spec} (use 7d, 30d, all or YYYY-MM-DD)`);
}

/** Skills and slash commands: the turn's cost split across the tools appearing in it (see header). */
function toolReport(
  db: DatabaseSync,
  kind: "skill" | "command",
  opts: { since?: string; profile?: string; limit?: number },
) {
  const filters: string[] = [];
  const args: (string | number)[] = [];
  const since = sinceDate(opts.since);
  if (since) {
    filters.push("m.day >= ?");
    args.push(since);
  }
  if (opts.profile) {
    filters.push("m.profile = ?");
    args.push(opts.profile);
  }
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
      -- *1.0: integer division truncates in SQLite, which under-counted per-skill tokens
      SUM(t.msgs) AS msgs, SUM(t.input * 1.0 / n.k) AS input, SUM(t.output * 1.0 / n.k) AS output,
      SUM(t.cache_read * 1.0 / n.k) AS cache_read, SUM(t.cache_write * 1.0 / n.k) AS cache_write,
      SUM(t.cost / n.k) AS cost, SUM(t.unpriced) AS unpriced
    FROM turn_tools tt JOIN t ON t.turn_id = tt.turn_id JOIN n ON n.turn_id = tt.turn_id
    WHERE tt.kind = ? GROUP BY key ORDER BY cost DESC NULLS LAST, uses DESC LIMIT ?`)
    .all(...args, kind, kind, opts.limit ?? 40) as unknown as Row[];
  const total = rows.reduce((a, x) => ({
    msgs: a.msgs + x.msgs,
    input: a.input + x.input,
    output: a.output + x.output,
    cache_read: a.cache_read + x.cache_read,
    cache_write: a.cache_write + x.cache_write,
    cost: (a.cost ?? 0) + (x.cost ?? 0),
  }), { msgs: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0 as number | null });
  const orphan = db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${wOrphan}`).get(...args) as
    | { n: number }
    | undefined;
  return {
    by: kind as GroupBy,
    split: null,
    since,
    profile: opts.profile ?? null,
    rows,
    total,
    spawns: [] as { key: string; n: number }[],
    orphanMsgs: orphan?.n ?? 0,
  };
}

export interface Row {
  key: string;
  label?: string;
  cwd?: string | null;
  day?: string;
  profile?: string;
  uses?: number;
  msgs: number;
  sessions: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  unpriced: number;
}

export function report(
  db: DatabaseSync,
  opts: { by: GroupBy; since?: string; profile?: string; limit?: number; split?: GroupBy },
) {
  if (opts.by === "skill" || opts.by === "command") return toolReport(db, opts.by, opts);
  const where: string[] = [];
  const args: (string | number)[] = [];
  const since = sinceDate(opts.since);
  if (since) {
    where.push("day >= ?");
    args.push(since);
  }
  if (opts.profile) {
    where.push("profile = ?");
    args.push(opts.profile);
  }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const col = GROUP_COL[opts.by as Exclude<GroupBy, "skill" | "command">];
  // split: a second dimension (e.g. by=day, split=profile gives one row per day and profile, for stacked charts)
  const scol = opts.split && opts.split !== opts.by
    ? GROUP_COL[opts.split as Exclude<GroupBy, "skill" | "command">]
    : null;
  // For project rows the slug is unreadable, so carry a cwd the caller can label with. Which cwd
  // matters: a session wanders into subdirectories, and MAX() would happily label the project
  // "src". The shortest recorded path is the closest thing to the project root — length-prefixed
  // so MIN() compares by depth rather than alphabetically, then sliced back off.
  const SHORTEST_CWD = "SUBSTR(MIN(PRINTF('%04d', LENGTH(cwd)) || cwd), 5) AS cwd,";
  const extra = opts.by === "project" ? SHORTEST_CWD : "";
  const rows = db.prepare(`
    SELECT COALESCE(${col}, '—') AS key, ${scol ? `COALESCE(${scol}, '—') AS ${opts.split},` : ""} ${extra} ${
    opts.by !== "day" ? "" : "day,"
  } COUNT(*) AS msgs, COUNT(DISTINCT session_id) AS sessions,
      SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_5m + cache_1h) AS cache_write,
      SUM(cost_usd) AS cost, SUM(cost_usd IS NULL) AS unpriced
    FROM messages ${w} GROUP BY key${scol ? `, ${opts.split}` : ""} ORDER BY ${
    opts.by === "day" ? "key ASC" : "cost DESC NULLS LAST, output DESC"
  } LIMIT ?`).all(...args, opts.limit ?? 40) as unknown as Row[];
  const total = db.prepare(
    `SELECT COUNT(*) AS msgs, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cache_5m + cache_1h) AS cache_write, SUM(cost_usd) AS cost FROM messages ${w}`,
  ).get(...args) as {
    msgs: number;
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
    cost: number | null;
  };
  const spawns = db.prepare(
    `SELECT subagent_type AS key, COUNT(*) AS n FROM agent_spawns ${w} GROUP BY key ORDER BY n DESC`,
  ).all(...args) as { key: string; n: number }[];
  if (opts.by === "project") { for (const r of rows) r.label = projectLabel(r.key, r.cwd); }
  return {
    by: opts.by,
    split: opts.split ?? null,
    since,
    profile: opts.profile ?? null,
    rows,
    total,
    spawns,
    orphanMsgs: 0,
  };
}

/** Recent sessions: one row per session_id with directory, time window, messages, models and cost. */
export function sessions(db: DatabaseSync, opts: { since?: string; profile?: string; limit?: number } = {}) {
  const where: string[] = ["session_id IS NOT NULL"];
  const args: (string | number)[] = [];
  const since = sinceDate(opts.since ?? "7d");
  if (since) {
    where.push("day >= ?");
    args.push(since);
  }
  if (opts.profile) {
    where.push("profile = ?");
    args.push(opts.profile);
  }
  const rows = db.prepare(`
    SELECT session_id, profile, SUBSTR(MIN(PRINTF('%04d', LENGTH(cwd)) || cwd), 5) AS cwd, MAX(entrypoint) AS entrypoint, MIN(ts) AS started, MAX(ts) AS ended,
      COUNT(*) AS msgs, SUM(sidechain) AS sidechain_msgs, SUM(output) AS output, SUM(cache_read) AS cache_read, SUM(cost_usd) AS cost,
      GROUP_CONCAT(DISTINCT model) AS models, GROUP_CONCAT(DISTINCT agent) AS agents
    FROM messages WHERE ${where.join(" AND ")} GROUP BY session_id ORDER BY ended DESC LIMIT ?`).all(
    ...args,
    opts.limit ?? 50,
  ) as {
    session_id: string;
    profile: string;
    cwd: string | null;
    entrypoint: string | null;
    started: string;
    ended: string;
    msgs: number;
    sidechain_msgs: number;
    output: number;
    cache_read: number;
    cost: number | null;
    models: string;
    agents: string;
  }[];
  return rows.map((r) => ({
    ...r,
    project: projectLabel(null, r.cwd),
    models: r.models.split(","),
    agents: r.agents.split(","),
    minutes: Math.max(0, Math.round((new Date(r.ended).getTime() - new Date(r.started).getTime()) / 60000)),
  }));
}
