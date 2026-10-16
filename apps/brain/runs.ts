// runs.ts — the agents of every machine in one view (ADR 0014, third round, B): each node publishes its own runs
// (hub children, routine firings, workflow runs) and routines, the whole list replacing the last; the web app reads
// them and follows a stream of changes. A Stop from the phone is a passkey's assertion the service only carries: the
// node it is for checks it as it checks a decline (apps/cli/node/runs.ts) and stops the child itself. Resuming
// elsewhere is a proposal raised for the run's job, accepted on the phone as any job is.

import type { DatabaseSync } from "node:sqlite";
import { isOnline, type JobSpec, type NodeInfo, place, validNodeName } from "../../shared/mcp/lib/nodes.ts";
import { cleanAssertion, MAX_AHEAD_MS } from "../../shared/mcp/lib/webauthn.ts";
import { Fleet, FleetError } from "./fleet.ts";

export class RunsError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** A node that has not published for this long has its live runs left out. */
const LIVE_MS = 10 * 60_000;
/** Ended runs are kept and listed this long, at most this many. */
const ENDED_KEEP_MS = 7 * 86400_000;
const RECENT = 50;
const MAX_RUNS = 100;
const MAX_ROUTINES = 20;
const TAIL_LINES = 5;
const TAIL_CHARS = 400;
/** A stop's assertion is kept no longer than its expiry and this. */
const STOP_KEEP_MS = 3600_000;
const KEEPALIVE_MS = 20_000;

const KINDS = ["child", "routine", "workflow"] as const;
const STATES = ["working", "waiting", "idle", "ended", "failed"] as const;
export type RunState = typeof STATES[number];
const ENDED: readonly string[] = ["ended", "failed"];

/** a run's id (a child's `<profile>-…`, a workflow run's) and a request's halves */
const SEGMENT = /^[\w.:-]{1,100}$/;
const str = (v: unknown, n: number) => typeof v === "string" ? v.slice(0, n) : "";
const iso = (v: unknown) => typeof v === "string" && v.length <= 40 && Date.parse(v) > 0 ? v : undefined;

export interface Run {
  id: string;
  kind: typeof KINDS[number];
  profile: string;
  provider?: string;
  project: string;
  repo?: string;
  branch?: string;
  /** the first line of its task, when the machine publishes in full */
  title?: string;
  started: string;
  updated: string;
  state: RunState;
  ended?: string;
  tail: string[];
  waiting?: string[];
  routine?: string;
  workflow?: { name: string; step: string; steps: { id: string; state: string }[] };
  /** the job on the service it belongs to (a routine's firing, a job placed here): what a resume carries on */
  job?: string;
  /** why it cannot move to another machine (no remote, a client's repository...), as the node knows */
  noMove?: string;
}

export interface Routine {
  name: string;
  schedule: string;
  next?: string;
  last?: string;
  enabled: boolean;
}

/** Pure: a run as the service keeps it: known fields only, text bounded again, junk dropped. */
export function cleanRun(raw: unknown): Run | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = str(r.id, 100);
  if (!SEGMENT.test(id)) return null;
  if (!KINDS.includes(r.kind as Run["kind"]) || !STATES.includes(r.state as RunState)) return null;
  const started = iso(r.started), updated = iso(r.updated) ?? started;
  if (!started || !updated) return null;
  const tail = Array.isArray(r.tail)
    ? r.tail.filter((l): l is string => typeof l === "string").slice(-TAIL_LINES).map((l) => l.slice(0, TAIL_CHARS))
    : [];
  const waiting = Array.isArray(r.waiting)
    ? r.waiting.filter((w): w is string => typeof w === "string" && /^[\w.:-]{1,100}\/[\w.:-]{1,100}$/.test(w))
      .slice(0, 20)
    : [];
  const out: Run = {
    id,
    kind: r.kind as Run["kind"],
    profile: str(r.profile, 60),
    project: str(r.project, 300),
    started,
    updated,
    state: r.state as RunState,
    tail,
  };
  for (const [k, n] of [["provider", 20], ["repo", 300], ["branch", 200], ["title", 200], ["routine", 100]] as const) {
    const v = str(r[k], n);
    if (v) out[k] = v;
  }
  const ended = iso(r.ended);
  if (ended && ENDED.includes(out.state)) out.ended = ended;
  if (waiting.length) out.waiting = waiting;
  if (typeof r.job === "string" && /^[\w-]{1,64}$/.test(r.job)) out.job = r.job;
  const noMove = str(r.noMove, 200);
  if (noMove) out.noMove = noMove;
  const w = r.workflow as Record<string, unknown> | undefined;
  if (w && typeof w === "object" && typeof w.name === "string") {
    out.workflow = {
      name: w.name.slice(0, 100),
      step: str(w.step, 100),
      steps: (Array.isArray(w.steps) ? w.steps : []).slice(0, 50).flatMap((s) => {
        const x = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
        return typeof x.id === "string" ? [{ id: x.id.slice(0, 100), state: str(x.state, 20) }] : [];
      }),
    };
  }
  return out;
}

/** Pure: a routine as the service keeps it. */
export function cleanRoutine(raw: unknown): Routine | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const name = str(r.name, 100).trim();
  if (!name) return null;
  const out: Routine = { name, schedule: str(r.schedule, 100), enabled: r.enabled === true };
  const next = iso(r.next), last = iso(r.last);
  if (next) out.next = next;
  if (last) out.last = last;
  return out;
}

const rank = (s: string) => s === "waiting" ? 0 : s === "working" ? 1 : 2;

/** Pure: the live runs in the view's order: waiting first, then working, then the newest. */
export const sortRuns = <T extends Pick<Run, "state" | "started">>(runs: T[]): T[] =>
  [...runs].sort((a, b) => rank(a.state) - rank(b.state) || b.started.localeCompare(a.started));

/** An event of the stream: a run changed, went (dropped from its node's list unended, or its machine forgotten),
 *  or a machine went offline or came back. */
export interface RunsEvent {
  event: "run" | "gone" | "node";
  data: Record<string, unknown>;
}

/** Who follows an account's runs. One per service: the pages of every account subscribe here. */
export class RunsHub {
  private subs = new Map<string, Set<(e: RunsEvent) => void>>();

  publish(user: string, e: RunsEvent) {
    for (const f of [...this.subs.get(user) ?? []]) f(e);
  }

  subscribe(user: string, f: (e: RunsEvent) => void): () => void {
    const set = this.subs.get(user) ?? new Set();
    set.add(f);
    this.subs.set(user, set);
    return () => {
      set.delete(f);
      if (!set.size) this.subs.delete(user);
    };
  }
}

export const runsHub = new RunsHub();

/** The tables, made here and not in store.ts: this slice's own. */
function ensureTables(db: DatabaseSync) {
  db.exec(`
create table if not exists runs (
  node text not null, id text not null, data text not null, state text not null, updated text not null,
  primary key (node, id));
create index if not exists runs_ended on runs(updated) where state in ('ended', 'failed');
create table if not exists run_routines (node text primary key, data text not null, updated text not null);
create table if not exists run_stops (
  seq integer primary key autoincrement, node text not null, run text not null, expires text not null,
  assertion text not null, created text not null, state text not null default 'pending', why text);`);
}

export class Runs {
  constructor(
    private db: DatabaseSync,
    private user: string,
    private hub: RunsHub = runsHub,
    private now = () => Date.now(),
  ) {
    ensureTables(db);
  }

  private at = () => new Date(this.now()).toISOString();

  /** The nodes the account knows, with when each was seen: a forgotten machine is not among them. */
  private nodes(): NodeInfo[] {
    return (this.db.prepare("select name, info, seen from nodes order by name").all() as {
      name: string;
      info: string;
      seen: string;
    }[]).map((r) => ({ ...JSON.parse(r.info), name: r.name, seen: r.seen }));
  }

  /** What time does: ended runs older than a week, stops past their keep, and the runs of a forgotten machine. */
  purge(): void {
    const now = this.now();
    this.db.prepare("delete from runs where state in ('ended', 'failed') and updated < ?").run(
      new Date(now - ENDED_KEEP_MS).toISOString(),
    );
    this.db.prepare("delete from runs where node not in (select name from nodes)").run();
    this.db.prepare("delete from run_routines where node not in (select name from nodes)").run();
    this.db.prepare("delete from run_stops where expires < ?").run(new Date(now - STOP_KEEP_MS).toISOString());
  }

  /** A node's list replaces what it said before. A run no longer in it goes, unless it had ended: those stay as
   *  recent. Every change is told to the pages that follow. */
  publish(node: string, body: Record<string, unknown>): { runs: number; routines: number } {
    if (!Array.isArray(body.runs)) throw new RunsError("runs is a list");
    const rows = body.runs.slice(0, MAX_RUNS).map(cleanRun).filter((r): r is Run => !!r);
    const routines = (Array.isArray(body.routines) ? body.routines : []).slice(0, MAX_ROUTINES).map(cleanRoutine)
      .filter((r): r is Routine => !!r);
    const at = this.at();
    const before = new Map(
      (this.db.prepare("select id, data, state from runs where node = ?").all(node) as {
        id: string;
        data: string;
        state: string;
      }[]).map((r) => [r.id, r]),
    );
    const events: RunsEvent[] = [];
    const online = this.online(node);
    this.db.exec("begin immediate");
    try {
      const put = this.db.prepare(
        "insert into runs (node, id, data, state, updated) values (?, ?, ?, ?, ?) on conflict(node, id) do update set data = excluded.data, state = excluded.state, updated = excluded.updated",
      );
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const data = JSON.stringify(r);
        if (before.get(r.id)?.data === data) continue;
        put.run(node, r.id, data, r.state, ENDED.includes(r.state) ? r.ended ?? at : at);
        events.push({ event: "run", data: { run: { ...r, node, online } } });
      }
      const drop = this.db.prepare("delete from runs where node = ? and id = ?");
      for (const [id, old] of before) {
        if (seen.has(id) || ENDED.includes(old.state)) continue;
        drop.run(node, id);
        events.push({ event: "gone", data: { id, node } });
      }
      this.db.prepare(
        "insert into run_routines (node, data, updated) values (?, ?, ?) on conflict(node) do update set data = excluded.data, updated = excluded.updated",
      ).run(node, JSON.stringify(routines), at);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
    if (Array.isArray(body.results)) this.report(node, body.results);
    for (const e of events) this.hub.publish(this.user, e);
    return { runs: rows.length, routines: routines.length };
  }

  private online(node: string): boolean {
    const n = this.nodes().find((x) => x.name === node);
    return !!n && isOnline(n, this.now());
  }

  /** The view: the live runs of the machines heard from lately, their routines, and what ended this week. */
  list(): {
    runs: (Run & { node: string; online: boolean })[];
    routines: (Routine & { node: string })[];
    recent: (Run & { node: string })[];
  } {
    this.purge();
    const now = this.now();
    const nodes = new Map(this.nodes().map((n) => [n.name, n]));
    const all = this.db.prepare("select node, data, state, updated from runs").all() as {
      node: string;
      data: string;
      state: string;
      updated: string;
    }[];
    const heard = new Map(
      (this.db.prepare("select node, data, updated from run_routines").all() as {
        node: string;
        data: string;
        updated: string;
      }[]).map((r) => [r.node, r]),
    );
    const lately = (node: string) => {
      const n = nodes.get(node), h = heard.get(node);
      const last = Math.max(n ? Date.parse(n.seen) : 0, h ? Date.parse(h.updated) : 0);
      return !!n && now - last < LIVE_MS;
    };
    const live = all.filter((r) => !ENDED.includes(r.state) && lately(r.node)).map((r) => ({
      ...JSON.parse(r.data) as Run,
      node: r.node,
      online: isOnline(nodes.get(r.node)!, now),
    }));
    const recent = all.filter((r) => ENDED.includes(r.state)).sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, RECENT).map((r) => ({ ...JSON.parse(r.data) as Run, node: r.node }));
    const routines = [...heard.values()].filter((h) => nodes.has(h.node)).flatMap((h) =>
      (JSON.parse(h.data) as Routine[]).map((r) => ({ ...r, node: h.node }))
    );
    return { runs: sortRuns(live), routines, recent };
  }

  private run(node: string, id: string): (Run & { stored: string }) | null {
    const r = this.db.prepare("select data, updated from runs where node = ? and id = ?").get(node, id) as
      | { data: string; updated: string }
      | undefined;
    return r ? { ...JSON.parse(r.data), stored: r.updated } : null;
  }

  // ------------------------------------------------------------ stop

  /** A stop from the phone, kept for the node to check: never decided here. */
  stop(node: string, id: string, raw: Record<string, unknown>): { run: string; node: string; state: "pending" } {
    const now = this.now();
    const r = this.run(node, id);
    if (!r) throw new RunsError("no such run on that machine", 404);
    if (ENDED.includes(r.state)) throw new RunsError("the run has ended", 409);
    const until = typeof raw.expires === "string" ? Date.parse(raw.expires) : NaN;
    if (!(until > now && until <= now + MAX_AHEAD_MS + 60_000)) throw new RunsError("expires is within ten minutes");
    const asm = cleanAssertion(raw.assertion);
    if (!asm) throw new RunsError("the assertion lacks a part");
    const known = this.db.prepare("select 1 from passkeys where id = ?").get(asm.credential);
    if (!known) throw new RunsError("not a passkey of this account");
    const open = this.db.prepare(
      "select 1 from run_stops where node = ? and run = ? and state = 'pending' and expires >= ?",
    ).get(node, id, new Date(now).toISOString());
    if (open) throw new RunsError("already asked: the machine has not picked it up yet", 409);
    this.db.prepare("insert into run_stops (node, run, expires, assertion, created) values (?, ?, ?, ?, ?)").run(
      node,
      id,
      new Date(until).toISOString(),
      JSON.stringify(asm),
      new Date(now).toISOString(),
    );
    return { run: id, node, state: "pending" };
  }

  /** The stops waiting for a node, as the announce's reply carries them. */
  stops(node: string): { run: string; expires: string; assertion: unknown }[] {
    const at = this.at();
    this.db.prepare(
      "update run_stops set state = 'refused', why = 'it expired before the machine picked it up' where state = 'pending' and expires < ?",
    ).run(at);
    return (this.db.prepare(
      "select run, expires, assertion from run_stops where node = ? and state = 'pending' order by seq",
    ).all(node) as { run: string; expires: string; assertion: string }[]).map((r) => ({
      run: r.run,
      expires: r.expires,
      assertion: JSON.parse(r.assertion),
    }));
  }

  /** What a node did with the stops it was given: `{id: "stop:<run>", ok, why?}` each. */
  report(node: string, raw: unknown[]): number {
    let n = 0;
    const set = this.db.prepare(
      "update run_stops set state = ?, why = ? where node = ? and run = ? and state = 'pending'",
    );
    for (const r of raw.slice(0, 100)) {
      const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      if (typeof x.id !== "string" || !x.id.startsWith("stop:")) continue;
      n += Number(
        set.run(
          x.ok === true ? "applied" : "refused",
          x.ok === true ? null : str(x.why, 300) || "refused",
          node,
          x.id.slice(5),
        )
          .changes,
      );
    }
    return n;
  }

  /** The stops of the last hour and how they ended, for the phone to say so. */
  recentStops(): { node: string; run: string; state: string; why: string | null; created: string }[] {
    return this.db.prepare(
      "select node, run, state, why, created from run_stops where created >= ? order by seq desc limit 50",
    ).all(new Date(this.now() - 3600_000).toISOString()) as {
      node: string;
      run: string;
      state: string;
      why: string | null;
      created: string;
    }[];
  }

  // ------------------------------------------------------------ resume elsewhere

  /** Why a run cannot be resumed elsewhere now, or null. Its job is what moves (ADR 0012); a run still working on a
   *  machine that is online is that machine's. */
  cannotResume(r: Run, nodeOnline: boolean): string | null {
    if (r.noMove) return r.noMove;
    if (!r.job) return "it has no job on the service: only a routine's firing or a placed job moves";
    if (nodeOnline && (r.state === "working" || r.state === "waiting")) {
      return "it is still running on an online machine";
    }
    return null;
  }

  /** A proposal to carry the run on elsewhere: a `resume` job, accepted with the passkey as any job is. */
  resume(node: string, id: string, raw: Record<string, unknown>): Record<string, unknown> {
    const r = this.run(node, id);
    if (!r) throw new RunsError("no such run on that machine", 404);
    const nodes = this.nodes(), now = this.now();
    const here = nodes.find((n) => n.name === node);
    const why = this.cannotResume(r, !!here && isOnline(here, now));
    if (why) throw new RunsError(`it cannot move: ${why}`, 409);
    const fleet = new Fleet(this.db, this.now);
    const parent = fleet.get(r.job!);
    if (!parent?.spec.id) throw new RunsError("its job names no run to carry on", 409);
    const wanted = typeof raw.node === "string" && raw.node ? raw.node : null;
    if (wanted && (!validNodeName(wanted) || wanted === node)) throw new RunsError("not another machine of yours");
    const target = wanted ?? place(parent.spec, nodes, now, node) ?? "";
    const spec: JobSpec = { ...parent.spec, from: node };
    try {
      const job = fleet.create("phone", {
        kind: "resume",
        node: target,
        spec,
        reason: `resume ${parent.spec.name} from ${node}, asked from the phone`,
      });
      return { job };
    } catch (e) {
      if (e instanceof FleetError) throw new RunsError(e.message, e.status);
      throw e;
    }
  }

  /** The machines whose online state differs from `last`, which it updates: the stream's `node` events. */
  nodeChanges(last: Map<string, boolean>): RunsEvent[] {
    const now = this.now(), out: RunsEvent[] = [];
    for (const n of this.nodes()) {
      const on = isOnline(n, now);
      if (last.has(n.name) && last.get(n.name) !== on) out.push({ event: "node", data: { node: n.name, online: on } });
      last.set(n.name, on);
    }
    return out;
  }
}

/** Server-Sent Events following an account's runs; a comment every 20 s keeps it open, and at each beat a machine
 *  that went offline (or came back) is told. */
function stream(req: Request, runs: Runs, hub: RunsHub, user: string): Response {
  const enc = new TextEncoder();
  let off: (() => void) | null = null, beat: ReturnType<typeof setInterval> | undefined;
  const last = new Map<string, boolean>();
  try {
    runs.nodeChanges(last);
  } catch { /* the account's database is busy: the first beat learns them */ }
  const end = () => {
    off?.();
    off = null;
    clearInterval(beat);
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const send = (s: string) => {
        try {
          c.enqueue(enc.encode(s));
        } catch {
          end();
        }
      };
      const event = (e: RunsEvent) => send(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
      send(": connected\n\n");
      off = hub.subscribe(user, event);
      beat = setInterval(() => {
        send(": \n\n");
        try {
          for (const e of runs.nodeChanges(last)) event(e);
        } catch { /* closed meanwhile: the abort ends this */ }
      }, KEEPALIVE_MS);
      req.signal.addEventListener("abort", () => {
        end();
        try {
          c.close();
        } catch { /* already closed */ }
      });
    },
    cancel: end,
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

/** The routes, for a caller signed in to the account. `node`: the machine whose token it is (null for a web session
 *  or a token that is no machine's). Null when the path is not one of these. */
export async function runsRoute(
  req: Request,
  u: URL,
  node: string | null,
  runs: Runs,
  user: string,
  hub: RunsHub = runsHub,
): Promise<Response | null> {
  const p = u.pathname, m = req.method;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  const body = async () => {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new RunsError("a JSON object is expected");
    return b as Record<string, unknown>;
  };
  try {
    if (p === "/api/node/runs" && m === "PUT") {
      if (!node || !validNodeName(node)) throw new RunsError("only a machine's own token does this", 403);
      return json({ ok: true, ...runs.publish(node, await body()) });
    }
    if (p === "/api/runs" && m === "GET") return json({ ...runs.list(), stops: runs.recentStops() });
    if (p === "/api/runs/events" && m === "GET") return stream(req, runs, hub, user);
    const one = p.match(/^\/api\/runs\/([^/]{1,64})\/([^/]{1,100})\/(stop|resume)$/);
    if (one && m === "POST") {
      let n: string, id: string;
      try {
        n = decodeURIComponent(one[1]);
        id = decodeURIComponent(one[2]);
      } catch {
        throw new RunsError("not a run");
      }
      if (!validNodeName(n) || !SEGMENT.test(id)) throw new RunsError("not a run");
      return json(one[3] === "stop" ? runs.stop(n, id, await body()) : runs.resume(n, id, await body()));
    }
  } catch (e) {
    if (e instanceof RunsError) return json({ error: e.message }, e.status);
    throw e;
  }
  return null;
}

/** The stops waiting for a node: the announce's reply carries them (fleet.ts). */
export const pendingStops = (db: DatabaseSync, node: string, now: () => number = () => Date.now()) =>
  new Runs(db, "", runsHub, now).stops(node);
