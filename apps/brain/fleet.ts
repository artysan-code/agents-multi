// fleet.ts — an account's machines and the jobs placed on them (ADR 0012): what each node last announced,
// and each job's life (proposed, accepted, running, ended or interrupted). The service only carries them: the
// owner's yes is a signature it stores and never checks, because the node checks it (shared/mcp/lib/nodes.ts)
// and the service never holds the key. A node is its machine token's name; it can announce only itself and
// claim or report only the jobs placed on it.

import type { DatabaseSync } from "node:sqlite";
import {
  type Announce,
  type Job,
  JOB_TTL_MS,
  type JobKind,
  type JobStatus,
  type NodeInfo,
  resumeOf,
  specErrors,
  sweep,
  validNodeName,
} from "../../shared/mcp/lib/nodes.ts";
import { cleanAssertion } from "../../shared/mcp/lib/webauthn.ts";
import { pendingStops } from "./runs.ts";

/** Ended jobs are listed for a week, at most this many. */
const ENDED_KEEP = 30;
const ENDED_DAYS = 7;

const num = (v: unknown, lo = 0, hi = Number.MAX_SAFE_INTEGER) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0;

/** Pure: an announcement as the service keeps it: known fields only, numbers bounded, junk dropped. */
export function cleanAnnounce(raw: unknown): Announce {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, n: number) => typeof v === "string" ? v.slice(0, n) : "";
  return {
    platform: str(r.platform, 20),
    version: str(r.version, 40),
    headless: r.headless === true,
    load: num(r.load, 0, 1e4),
    memTotal: num(r.memTotal),
    memFree: num(r.memFree),
    cap: Math.floor(num(r.cap, 0, 256)),
    running: Math.floor(num(r.running, 0, 1e4)),
    accounts: Array.isArray(r.accounts)
      ? r.accounts.filter((a): a is string => typeof a === "string" && /^[A-Za-z0-9][\w.-]*\/[a-z]+$/.test(a)).slice(
        0,
        50,
      )
      : [],
    present: r.present === true,
    sandbox: typeof r.sandbox === "boolean" ? r.sandbox : null,
    voice: r.voice === true,
    ...(typeof r.gitKey === "string" && GIT_KEY.test(r.gitKey) ? { gitKey: r.gitKey } : {}),
    ...(Array.isArray(r.waits)
      ? { waits: r.waits.filter((w): w is string => typeof w === "string").slice(0, 10).map((w) => str(w, 200)) }
      : {}),
  };
}

/** A git key's public half as a server announces it: an OpenSSH ed25519 key, with its comment. */
const GIT_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68}={0,2}( [\x20-\x7e]{1,100})?$/;

interface JobRow {
  id: string;
  node: string;
  kind: string;
  spec: string;
  status: string;
  reason: string | null;
  local: number;
  signature: string | null;
  assertion: string | null;
  expires: string | null;
  created: string;
  updated: string;
  by: string;
  head: string | null;
  parent: string | null;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  node: r.node,
  kind: r.kind as JobKind,
  spec: JSON.parse(r.spec),
  status: r.status as JobStatus,
  ...(r.reason ? { reason: r.reason } : {}),
  ...(r.local ? { local: true } : {}),
  ...(r.signature ? { signature: r.signature } : {}),
  ...(r.assertion ? { assertion: JSON.parse(r.assertion) } : {}),
  ...(r.expires ? { expires: r.expires } : {}),
  created: r.created,
  updated: r.updated,
  by: r.by,
  ...(r.head ? { head: r.head } : {}),
  ...(r.parent ? { parent: r.parent } : {}),
});

export class FleetError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export class Fleet {
  constructor(
    private db: DatabaseSync,
    private now = () => Date.now(),
    private newId: () => string = () => crypto.randomUUID(),
    /** what the announcing token says the node is: `server` for a node token (ADR 0013, F2), kept on its row */
    private kind?: "server",
  ) {}

  nodes(): NodeInfo[] {
    return (this.db.prepare("select name, info, seen from nodes order by name").all() as {
      name: string;
      info: string;
      seen: string;
    }[]).map((r) => ({ ...JSON.parse(r.info), name: r.name, seen: r.seen }));
  }

  get(id: string): Job | null {
    const r = this.db.prepare("select * from jobs where id = ?").get(id) as JobRow | undefined;
    return r ? toJob(r) : null;
  }

  /** The jobs still open, and the ones that ended this week (the latest first). */
  jobs(): Job[] {
    const since = new Date(this.now() - ENDED_DAYS * 86400_000).toISOString();
    const open = this.db.prepare(
      "select * from jobs where status in ('proposed', 'accepted', 'running') order by created",
    ).all() as unknown as JobRow[];
    const ended = this.db.prepare(
      "select * from jobs where status not in ('proposed', 'accepted', 'running') and updated >= ? order by updated desc limit ?",
    ).all(since, ENDED_KEEP) as unknown as JobRow[];
    return [...open, ...ended].map(toJob);
  }

  /** The jobs the phone declined with a passkey in the last day that this node must check: its own, or the ones
   *  it proposed with nowhere to go yet. The service keeps the assertion and decides nothing about it. */
  declined(name: string): Job[] {
    const since = new Date(this.now() - JOB_TTL_MS).toISOString();
    return (this.db.prepare(
      "select * from jobs where status = 'declined' and assertion is not null and updated >= ? and (node = ? or (node = '' and by = ?)) order by updated",
    ).all(since, name, name) as unknown as JobRow[]).map(toJob);
  }

  /** A machine forgotten: its row, what waits on it and the phone's answers not yet taken. True when it was known.
   *  Its jobs stay (history); the tokens and the turns are the caller's (chat.ts `forgetNode`). */
  forget(name: string): boolean {
    this.db.exec("begin immediate");
    try {
      const r = this.db.prepare("delete from nodes where name = ?").run(name);
      this.db.prepare("delete from waiting where node = ?").run(name);
      this.db.prepare("delete from waiting_answers where node = ? and state = 'pending'").run(name);
      this.db.exec("commit");
      return Number(r.changes) > 0;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  /** The phone's stops of this node's runs, for it to check (runs.ts). */
  stops(name: string): ReturnType<typeof pendingStops> {
    return pendingStops(this.db, name, this.now);
  }

  /** A node's announcement; the answer is what has been accepted for it. */
  announce(name: string, a: Announce): Job[] {
    if (!validNodeName(name)) throw new FleetError("not a node name");
    const seen = new Date(this.now()).toISOString();
    this.db.prepare(
      "insert into nodes (name, info, seen) values (?, ?, ?) on conflict(name) do update set info = excluded.info, seen = excluded.seen",
    ).run(name, JSON.stringify({ ...a, ...(this.kind ? { kind: this.kind } : {}) }), seen);
    this.sweep();
    return (this.db.prepare("select * from jobs where node = ? and status = 'accepted' order by created").all(
      name,
    ) as unknown as JobRow[]).map(toJob);
  }

  /** What time did: the running jobs of a node gone silent are interrupted, each with a proposal to resume it
   *  elsewhere; what waited too long lapses. */
  sweep(): void {
    const now = this.now();
    const all = (this.db.prepare(
      "select * from jobs where status in ('proposed', 'accepted', 'running') or parent is not null",
    ).all() as unknown as JobRow[]).map(toJob);
    const s = sweep(this.nodes(), all, now);
    if (!s.interrupted.length && !s.lapsed.length && !s.resume.length) return;
    const at = new Date(now).toISOString();
    this.db.exec("begin immediate");
    try {
      const set = this.db.prepare("update jobs set status = ?, reason = coalesce(?, reason), updated = ? where id = ?");
      for (const id of s.interrupted) set.run("interrupted", "its node went silent", at, id);
      for (const id of s.lapsed) set.run("lapsed", "nobody answered in time", at, id);
      for (const r of s.resume) this.insert(resumeOf(r.parent, r.node, this.newId(), new Date(now)));
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }

  private insert(j: Job) {
    this.db.prepare(
      "insert into jobs (id, node, kind, spec, status, reason, local, signature, assertion, expires, created, updated, by, head, parent) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      j.id,
      j.node,
      j.kind,
      JSON.stringify(j.spec),
      j.status,
      j.reason ?? null,
      j.local ? 1 : 0,
      j.signature ?? null,
      j.assertion ? JSON.stringify(j.assertion) : null,
      j.expires ?? null,
      j.created,
      j.updated,
      j.by,
      j.head ?? null,
      j.parent ?? null,
    );
  }

  /** A new job from a node: a proposal (for any node, or none yet), or a node's own firing (`local`), which is
   *  running on that node from the start and never needs a signature. */
  create(by: string, body: Record<string, unknown>): Job {
    const kind = body.kind;
    if (kind !== "routine" && kind !== "resume") throw new FleetError("kind is routine or resume");
    const errs = specErrors(body.spec);
    if (errs.length) throw new FleetError(`the spec lacks a valid ${errs.join(", ")}`);
    const local = body.local === true;
    const node = local ? by : typeof body.node === "string" ? body.node : "";
    if (node && !validNodeName(node)) throw new FleetError("not a node name");
    const at = new Date(this.now()).toISOString();
    const j: Job = {
      id: this.newId(),
      node,
      kind,
      spec: body.spec as Job["spec"],
      status: local ? "running" : "proposed",
      ...(typeof body.reason === "string" ? { reason: body.reason.slice(0, 300) } : {}),
      ...(local ? { local: true } : {}),
      created: at,
      updated: at,
      by,
      ...(typeof body.head === "string" ? { head: body.head.slice(0, 64) } : {}),
    };
    this.insert(j);
    return j;
  }

  /** The owner's answer or a node's step on a job. `accept` stores the signature (and the node it was signed
   *  for, when the proposal had none); `claim` and `report` only from the job's node. */
  act(id: string, by: string, body: Record<string, unknown>, phone = false): Job {
    const j = this.get(id);
    if (!j) throw new FleetError("no such job", 404);
    const at = new Date(this.now()).toISOString();
    const set = (fields: Record<string, string | null>) => {
      const keys = Object.keys(fields);
      this.db.prepare(`update jobs set ${keys.map((k) => `${k} = ?`).join(", ")}, updated = ? where id = ?`).run(
        ...keys.map((k) => fields[k]),
        at,
        id,
      );
      return this.get(id)!;
    };
    switch (body.op) {
      case "accept": {
        if (j.status !== "proposed") throw new FleetError(`the job is ${j.status}`, 409);
        const node = typeof body.node === "string" && body.node ? body.node : j.node;
        if (!validNodeName(node)) throw new FleetError("accept names the node it runs on");
        // the owner's yes: an Ed25519 signature from a desktop, or an endorsed passkey's assertion from the phone;
        // either way the service only keeps it, the node checks it
        const sig = body.signature, expires = body.expires;
        const asm = body.assertion === undefined ? null : cleanAssertion(body.assertion);
        if (body.assertion !== undefined && !asm) throw new FleetError("the assertion lacks a part");
        if (!asm && (typeof sig !== "string" || !/^[\w-]{40,200}$/.test(sig))) throw new FleetError("no signature");
        const until = typeof expires === "string" ? Date.parse(expires) : NaN;
        if (!(until > this.now() && until <= this.now() + JOB_TTL_MS + 60_000)) {
          throw new FleetError("expires is within a day");
        }
        return set({
          status: "accepted",
          node,
          signature: asm ? null : sig as string,
          assertion: asm ? JSON.stringify(asm) : null,
          expires: new Date(until).toISOString(),
        });
      }
      case "decline": {
        if (j.status !== "proposed" && j.status !== "accepted") throw new FleetError(`the job is ${j.status}`, 409);
        const reason = typeof body.reason === "string" ? body.reason.slice(0, 300) : null;
        // a machine's or a desktop's decline carries no assertion; the approval's, if the job had one, goes, so
        // that only a phone's signed decline is ever handed to a node as one
        if (!phone) return set({ status: "declined", reason, assertion: null });
        // the phone's decline is signed as its approval is: a stolen web session cannot stop the owner's work
        // either. The service keeps the assertion and its expiry; the node that owns the job checks them.
        const asm = cleanAssertion(body.assertion);
        if (!asm) throw new FleetError("a decline from the phone needs a passkey's assertion");
        const until = typeof body.expires === "string" ? Date.parse(body.expires) : NaN;
        if (!(until > this.now() && until <= this.now() + JOB_TTL_MS + 60_000)) {
          throw new FleetError("expires is within a day");
        }
        return set({
          status: "declined",
          reason,
          assertion: JSON.stringify(asm),
          signature: null,
          expires: new Date(until).toISOString(),
        });
      }
      case "claim":
        if (j.node !== by) throw new FleetError("not this node's job", 403);
        if (j.status !== "accepted") throw new FleetError(`the job is ${j.status}`, 409);
        return set({ status: "running" });
      case "report": {
        if (j.node !== by) throw new FleetError("not this node's job", 403);
        // an interrupted job whose node came back is still that node's: it says how it ended
        if (!["running", "interrupted"].includes(j.status)) throw new FleetError(`the job is ${j.status}`, 409);
        const status = body.status;
        if (status !== "running" && status !== "done" && status !== "failed") {
          throw new FleetError("status is running, done or failed");
        }
        return set({
          status,
          head: typeof body.head === "string" ? body.head.slice(0, 64) : j.head ?? null,
          reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : j.reason ?? null,
        });
      }
      default:
        throw new FleetError("op is accept, decline, claim or report");
    }
  }
}

/** The fleet's routes, for a caller signed in to the account. `node`: the machine whose token it is (null for
 *  any other caller, who may only read). Null when the path is not the fleet's. */
export async function fleetRoute(
  req: Request,
  u: URL,
  node: string | null,
  fleet: Fleet,
  /** more for the announce's reply, for the node that announced (the phone's answers waiting for it) */
  alsoToNode: (node: string) => Record<string, unknown> = () => ({}),
  /** the caller is the person's web session (the phone) */
  phone = false,
): Promise<Response | null> {
  const p = u.pathname;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  const body = async () => {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new FleetError("a JSON object is expected");
    return b as Record<string, unknown>;
  };
  const write = () => {
    if (!node) throw new FleetError("only a machine's own token acts on nodes and jobs", 403);
    return node;
  };
  try {
    if (p === "/api/node" && req.method === "PUT") {
      const me = write();
      const jobs = fleet.announce(me, cleanAnnounce(await body()));
      return json({ jobs, declined: fleet.declined(me), stops: fleet.stops(me), ...alsoToNode(me) });
    }
    if (p === "/api/nodes" && req.method === "GET") {
      fleet.sweep();
      return json({ nodes: fleet.nodes(), jobs: fleet.jobs(), now: new Date().toISOString() });
    }
    if (p === "/api/jobs" && req.method === "POST") return json({ job: fleet.create(write(), await body()) });
    const one = p.match(/^\/api\/jobs\/([\w-]{1,64})$/);
    if (one && req.method === "GET") {
      const j = fleet.get(one[1]);
      return j ? json({ job: j }) : json({ error: "no such job" }, 404);
    }
    if (one && req.method === "POST") {
      const b = await body();
      // the phone has the account's web session, not a machine's token: it may accept a proposal with a
      // passkey's assertion (which a node checks before it runs anything) or decline one, and nothing else
      if (!node && !(phone && (b.op === "decline" || (b.op === "accept" && b.assertion !== undefined)))) write();
      return json({ job: fleet.act(one[1], node ?? "", b, !node) });
    }
  } catch (e) {
    if (e instanceof FleetError) return json({ error: e.message }, e.status);
    throw e;
  }
  return null;
}
