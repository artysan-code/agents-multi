// agentd.ts — the console's backend as a node (ADR 0012). Every 30 s, when the node is on (`config/node.json`):
// it announces itself to the service and gets back the jobs accepted for it; it runs one only when the owner's
// signature holds here (never on the service's word), it has room and a clone of the repository; it takes it as
// a one-shot routine, so the run policy, the reviewer and the timeout are the routines' (routines.ts); and it
// pushes each run's branch and HANDOFFs as they move (moving.ts) and reports to the service, so that a run on a
// machine that goes off can resume on another. On a headless node the routines start only once the sandbox
// probe passes, and stop if it fails.

import { type Job, type JobSpec, verifyJob } from "../../../shared/mcp/lib/nodes.ts";
import { loadNodeConfig, type NodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { runsDir } from "../../../shared/mcp/lib/agents.ts";
import { checkpoint, findClone, type Mark, remoteOf } from "../../../shared/mcp/lib/moving.ts";
import {
  type Fired,
  listRoutines,
  readState,
  type Routine,
  routinesDir,
  saveRoutine,
} from "../../../shared/mcp/lib/routines.ts";
import { parseAccountId } from "../../../shared/mcp/lib/limitrules.ts";
import { HOME } from "../lib/paths.ts";
import { approvalKey, nodeFacts, nodeName } from "./facts.ts";
import { sandboxProbe } from "./probe.ts";
import { actOn, announce, newJob, type Service, service } from "./service.ts";

export const TICK_MS = 30_000;
const PROBE_MS = 3600_000;

/** What agentd remembers between ticks, in `<runs>/node/state.json`: the jobs it took or refused (a job is
 *  never taken twice), and for each run it follows, its job on the service and its last checkpoint. */
export interface NodeState {
  seen: string[];
  runs: Record<string, { job: string; mark: Mark; done?: boolean; error?: string }>;
}

export const nodeStateFile = (runs = runsDir()) => `${runs}/node/state.json`;

export async function readNodeState(file = nodeStateFile()): Promise<NodeState> {
  const s = await Deno.readTextFile(file).then(JSON.parse).catch(() => null) as Partial<NodeState> | null;
  return { seen: s?.seen ?? [], runs: s?.runs ?? {} };
}

async function writeNodeState(st: NodeState, file = nodeStateFile()) {
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  // what is done stays a while, to be reported once; the seen list is what keeps a job from running twice
  const runs = Object.entries(st.runs);
  const keep = Object.fromEntries([...runs.filter(([, r]) => !r.done), ...runs.filter(([, r]) => r.done).slice(-100)]);
  const tmp = `${file}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify({ seen: st.seen.slice(-500), runs: keep }, null, 2) + "\n");
  await Deno.rename(tmp, file);
}

/** Pure: the one-shot routine that runs a verified job here, in the clone at `clone`. A resume carries on the
 *  run it names, as one child of the job's account (or its child's profile). */
export function jobRoutine(job: Job, clone: string, now: Date): Routine {
  const s = job.spec;
  const action = s.action as unknown as Routine["action"];
  const account = s.account ? parseAccountId(s.account) : null;
  const profile = account?.profile ?? (action.kind === "agent" ? action.profile : undefined);
  if (job.kind === "resume" && (!s.id || !profile)) throw new Error("a resume names its run and its account");
  return {
    id: `job-${job.id.replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase()}`,
    name: s.name,
    trigger: { kind: "at", at: now.toISOString() },
    action,
    folder: s.path ? `${clone}/${s.path}` : clone,
    project: clone,
    enabled: true,
    created: now.toISOString(),
    job: {
      id: job.id,
      ...(job.kind === "resume"
        ? {
          resume: {
            run: s.id!,
            from: s.from ?? "another machine",
            profile: profile!,
            ...(account?.provider === "codex" ? { provider: "codex" as const } : {}),
          },
        }
        : {}),
    },
  };
}

/** Pure: the spec of a run that fired here, as the service keeps it, so that it can resume elsewhere. */
export function specOfRun(r: Routine, f: Fired, repo: string): JobSpec {
  const a = r.action;
  const profile = r.job?.resume?.profile ?? (a.kind === "agent" ? a.profile : undefined);
  const provider = r.job?.resume?.provider ?? (a.kind === "agent" ? a.provider : undefined);
  return {
    name: r.name,
    repo,
    path: r.folder === r.project ? "" : r.folder.slice(r.project.length + 1),
    action: a as unknown as JobSpec["action"],
    ...(profile ? { account: `${profile}/${provider ?? "claude"}` } : {}),
    id: f.id,
  };
}

/** Pure: whether this node takes an accepted job now: `refuse` (with why: it will never run here), `wait` (no
 *  room, or the sandbox not ready), or `take`. `why` is verifyJob's verdict. */
export function decide(
  why: string | null,
  room: boolean,
  sandboxReady: boolean,
): { act: "refuse"; why: string } | { act: "wait" } | { act: "take" } {
  if (why) return { act: "refuse", why };
  return room && sandboxReady ? { act: "take" } : { act: "wait" };
}

export interface Agentd {
  headless: boolean;
  log: (s: string) => void;
  notify: (title: string, body: string) => void;
  /** starts the routines' tick; returns what stops it */
  startRoutines: () => () => void;
}

/** One pass: announce, take what is accepted and verified, follow the runs. */
export async function nodeTick(
  cfg: NodeConfig,
  svc: Service,
  sandbox: boolean | null,
  o: Pick<Agentd, "log" | "notify">,
): Promise<void> {
  const self = nodeName(cfg);
  const st = await readNodeState();
  const facts = await nodeFacts(cfg, sandbox);
  const { jobs } = await announce(svc, facts);
  const key = await approvalKey(cfg);
  let running = facts.running;
  for (const j of jobs) {
    if (st.seen.includes(j.id)) continue;
    const why = key
      ? await verifyJob(j, key, self, Date.now(), st.seen)
      : "this node has no approval key (no vault here: approvalKey in node.json)";
    const d = decide(why, running < facts.cap, !cfg.headless || sandbox === true);
    if (d.act === "wait") continue;
    let refusal = d.act === "refuse" ? d.why : null;
    const clone = refusal ? null : await findClone(j.spec.repo, cfg.repoRoots, HOME);
    if (!refusal && !clone) refusal = `no clone of ${j.spec.repo} under ${cfg.repoRoots.join(", ")}`;
    st.seen.push(j.id);
    if (refusal) {
      o.log(`node: job ${j.id} refused: ${refusal}`);
      o.notify(`A job was refused on ${self}`, `${j.spec.name}: ${refusal}`);
      await actOn(svc, j.id, { op: "decline", reason: `${self} refused it: ${refusal}` }).catch(() => {});
      continue;
    }
    try {
      await actOn(svc, j.id, { op: "claim" });
      const r = jobRoutine(j, clone!, new Date());
      await saveRoutine(r, routinesDir());
      running++;
      o.log(`node: job ${j.id} (${j.kind} ${j.spec.name}) taken as routine ${r.id}`);
    } catch (e) {
      o.log(`node: job ${j.id}: ${(e as Error).message}`);
      await actOn(svc, j.id, { op: "report", status: "failed", reason: (e as Error).message }).catch(() => {});
    }
  }
  await followRuns(svc, st, o.log);
  await writeNodeState(st);
}

/** The runs fired here: each gets its job on the service (the job it came from, or a `local` one), its branch
 *  and HANDOFFs pushed when they moved, and its end reported once. */
async function followRuns(svc: Service, st: NodeState, log: (s: string) => void) {
  for (const r of await listRoutines()) {
    const state = await readState(r.id);
    for (const f of state.runs) {
      let rec = st.runs[f.id];
      if (!rec) {
        if (f.ended && !r.job) continue; // ended before this node followed it
        const repo = await remoteOf(r.project);
        if (!repo) {
          st.runs[f.id] = { job: "", mark: {}, done: true, error: "no remote: it cannot move" };
          log(`node: run ${f.id} has no remote to move through`);
          continue;
        }
        const job = r.job?.id ??
          (await newJob(svc, { kind: "routine", local: true, spec: specOfRun(r, f, repo) }).catch((e) => {
            log(`node: run ${f.id}: ${(e as Error).message}`);
            return null;
          }))?.id;
        if (!job) continue;
        rec = st.runs[f.id] = { job, mark: {} };
      }
      if (rec.done) continue;
      if (await Deno.stat(f.worktree).catch(() => null)) {
        try {
          const m = await checkpoint(f.worktree, f.id, rec.mark);
          if (m.head !== rec.mark.head && !f.ended) {
            await actOn(svc, rec.job, { op: "report", status: "running", head: m.head });
          }
          rec.mark = { head: m.head, handoffs: m.handoffs };
          delete rec.error;
        } catch (e) {
          const msg = (e as Error).message;
          if (rec.error !== msg) log(`node: checkpoint of ${f.id}: ${msg}`);
          rec.error = msg;
        }
      }
      if (f.ended) {
        await actOn(svc, rec.job, { op: "report", status: "done", head: rec.mark.head }).then(
          () => rec.done = true,
          (e) => log(`node: report of ${f.id}: ${(e as Error).message}`),
        );
      }
    }
  }
}

/** Starts agentd in the console's backend; returns what stops it. The routines start at once on a desktop, and
 *  on a headless node only while the sandbox probe passes. */
export function startAgentd(o: Agentd): () => void {
  let stopRoutines: (() => void) | null = o.headless ? null : o.startRoutines();
  let sandbox: boolean | null = null;
  let stopped = false, busy = false, said = "";
  const probe = async () => {
    if (!o.headless) return;
    const p = await sandboxProbe();
    sandbox = p.ok;
    if (p.ok && !stopRoutines) {
      o.log("node: the sandbox works: routines and jobs on");
      stopRoutines = o.startRoutines();
    } else if (!p.ok) {
      o.log(`node: no job and no routine here: ${p.reason}`);
      stopRoutines?.();
      stopRoutines = null;
    }
  };
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const cfg = await loadNodeConfig();
      if (!cfg.enabled) return;
      const svc = await service();
      if (typeof svc === "string") {
        if (said !== svc) o.log(`node: ${svc}`);
        said = svc;
        return;
      }
      said = "";
      await nodeTick(cfg, svc, sandbox, o);
    } catch (e) {
      const msg = (e as Error).message;
      if (said !== msg) o.log(`node: ${msg}`);
      said = msg;
    } finally {
      busy = false;
    }
  };
  void probe().then(tick);
  const t = setInterval(tick, TICK_MS);
  const p = setInterval(() => void probe(), PROBE_MS);
  o.log(`schedule: node${o.headless ? " (headless)" : ""}`);
  return () => {
    stopped = true;
    clearInterval(t);
    clearInterval(p);
    stopRoutines?.();
  };
}
