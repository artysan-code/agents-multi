// runs.ts — this machine's agents, published to the service for the phone's Agents view (ADR 0014, third round,
// B): the hub's children, the routines' firings and the workflow runs, each with its state and the last lines it
// said (masked, bounded), the whole list replacing the last. What goes out is this machine's choice (`runs` in
// its node.json) and never a client's: a repository that is not the owner's (not in `repos` nor `gitHosts`) goes
// as its state only, its names replaced. A Stop from the phone is believed only after this node checked the
// passkey (its endorsement, the revocations, the assertion, a replay record), as a decline is.

import { type Child, listChildren, runsDir, stopChild } from "../../../shared/mcp/lib/agents.ts";
import type { NodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { maskValues } from "../../../shared/mcp/lib/mask.ts";
import { remoteOf } from "../../../shared/mcp/lib/moving.ts";
import { canonical, normalRemote, type PasskeyAssertion } from "../../../shared/mcp/lib/nodes.ts";
import { listRoutines, readState, type Routine, type RoutineState } from "../../../shared/mcp/lib/routines.ts";
import { answerRun, listRuns, type Run as WorkflowRun } from "../../../shared/mcp/lib/runs.ts";
import {
  b64u,
  cleanAssertion,
  MAX_AHEAD_MS,
  type PasskeyCtx,
  verifyPasskey,
} from "../../../shared/mcp/lib/webauthn.ts";
import { HOME } from "../lib/paths.ts";
import type { Service } from "./service.ts";

export type RunsMode = "full" | "state" | "off";
export type RunState = "working" | "waiting" | "idle" | "ended" | "failed";

/** A run as the service is told (apps/brain/runs.ts keeps the same shape). */
export interface PublishedRun {
  id: string;
  kind: "child" | "routine" | "workflow";
  profile: string;
  provider?: string;
  project: string;
  repo?: string;
  branch?: string;
  title?: string;
  started: string;
  updated: string;
  state: RunState;
  ended?: string;
  tail: string[];
  waiting?: string[];
  routine?: string;
  workflow?: { name: string; step: string; steps: { id: string; state: string }[] };
  job?: string;
  noMove?: string;
}

export interface PublishedRoutine {
  name: string;
  schedule: string;
  next?: string;
  last?: string;
  enabled: boolean;
}

export const MAX_RUNS = 100;
export const MAX_ROUTINES = 20;
const TAIL_LINES = 5;
const TAIL_CHARS = 400;
/** ended runs are published this long after they ended: the service keeps them a week as recent */
const ENDED_MS = 7 * 86400_000;
/** a change goes out at most this often */
export const PUBLISH_MS = 2000;
const CLIENT = "(client)";

// ---------------------------------------------------------------- pure

/** Pure: the last lines a child said, each bounded and masked: what the view shows of its output. */
export function tailOf(said: string[]): string[] {
  return said.flatMap((s) => s.split("\n")).map((l) => l.trimEnd()).filter((l) => l.trim()).slice(-TAIL_LINES)
    .map((l) => maskValues(l).slice(0, TAIL_CHARS));
}

/** Pure: the first line of a task, bounded and masked: the run's title. */
export const titleOf = (task: string | undefined): string | undefined => {
  const l = (task ?? "").split("\n").map((x) => x.trim()).find(Boolean);
  return l ? maskValues(l).slice(0, 120) : undefined;
};

/** Pure: a folder as the view names it: its path under the home folder (`personal/dnd/dragons-lair`). */
export function projectName(dir: string | undefined, home: string): string {
  if (!dir) return "";
  const h = home.replace(/\/+$/, "");
  return h && dir.startsWith(`${h}/`) ? dir.slice(h.length + 1) : dir.split("/").filter(Boolean).pop() ?? "";
}

/** Pure: whether a repository (a normalised remote, `host/path`) is the owner's: in `repos`, or under one of the
 *  `gitHosts` prefixes (`host` or `host/owner`), matched on whole segments, never as a substring. No remote is
 *  nobody's that this rule can tell: not the owner's. */
export function ownRepo(repo: string | null | undefined, repos: string[], gitHosts: string[]): boolean {
  if (!repo) return false;
  if (repos.some((r) => normalRemote(r) === repo)) return true;
  return gitHosts.some((h) => {
    const p = h.trim().toLowerCase().replace(/^[a-z+]+:\/\//, "").replace(/\/+$/, "");
    return !!p && (repo === p || repo.startsWith(`${p}/`));
  });
}

/** Pure: what a run becomes for this machine's choice and the repository's owner: `state` drops the output and the
 *  branch; a client's repository goes as `state` whatever the machine says, its project and remote named `(client)`. */
export function redact(r: PublishedRun, mode: RunsMode, own: boolean): PublishedRun {
  if (mode === "full" && own) return r;
  const { tail: _t, branch: _b, title: _x, ...rest } = r;
  const out: PublishedRun = { ...rest, tail: [] };
  if (!own) {
    out.project = CLIENT;
    if (out.repo) out.repo = CLIENT;
    if (out.routine) out.routine = CLIENT;
    if (out.workflow) out.workflow = { ...out.workflow, name: CLIENT };
    out.noMove ??= "a client's repository";
  }
  return out;
}

/** Pure: a child's phase as a run's state; a child that ended with an error failed. */
export function stateOfChild(c: Child): RunState {
  if (c.state.phase === "ended") return c.state.error ? "failed" : "ended";
  return c.state.phase;
}

/** Pure: a workflow run's state from its own and its running steps' children. */
export function stateOfWorkflow(w: WorkflowRun, children: Map<string, Child>): RunState {
  if (w.state.status === "done") return "ended";
  if (w.state.status === "stopped" || (!w.alive && w.state.status === "running")) {
    return Object.values(w.state.steps).some((s) => s.status === "failed") ? "failed" : "ended";
  }
  const steps = Object.values(w.state.steps);
  const kids = steps.map((s) => s.child && children.get(s.child)).filter((c): c is Child => !!c);
  if (
    steps.some((s) => s.status === "confirm" || s.status === "failed") || kids.some((c) => c.state.phase === "waiting")
  ) {
    return "waiting";
  }
  return kids.some((c) => c.state.phase === "working") ? "working" : "idle";
}

/** Pure: a routine's schedule in words a person reads. */
export function scheduleOf(r: Routine): string {
  const t = r.trigger;
  if (t.kind === "cron") return t.expr;
  if (t.kind === "at") return `at ${t.at}`;
  return `on ${t.on}`;
}

/** What the collector knows beside the hub: when each file last moved, the remote and branch of a folder. */
export interface Facts {
  home: string;
  now: number;
  /** when the child's or the run's files last changed (ISO) */
  touched: (id: string) => string | undefined;
  repoOf: (dir: string) => string | null;
  branchOf: (dir: string) => string | undefined;
  /** the service's job of a routine's firing or a placed job, by the firing's run id */
  jobOf: (firedId: string) => string | undefined;
}

/** Pure: this machine's runs as the service is told, before redaction: the workflow runs (their steps' children
 *  inside them), the routines' firings, the other children; ended ones of the last week only, live ones first. */
export function collect(
  children: Child[],
  workflows: WorkflowRun[],
  routines: { r: Routine; st: RoutineState }[],
  f: Facts,
): { runs: { run: PublishedRun; dir: string }[]; routines: { routine: PublishedRoutine; repo: string | null }[] } {
  const byId = new Map(children.map((c) => [c.meta.id, c]));
  const fired = new Map<string, { r: Routine; firing: RoutineState["runs"][number] }>();
  for (const { r, st } of routines) {
    for (const x of st.runs) {
      if (x.child) fired.set(x.child, { r, firing: x });
      if (x.run) fired.set(x.run, { r, firing: x });
    }
  }
  const out: { run: PublishedRun; dir: string }[] = [];
  const inWorkflow = new Set<string>();
  for (const w of workflows) {
    const steps = Object.entries(w.state.steps);
    for (const [, s] of steps) if (s.child) inWorkflow.add(s.child);
    const current = steps.find(([, s]) => ["running", "confirm", "failed"].includes(s.status)) ??
      steps.filter(([, s]) => s.started).sort((a, b) => (b[1].started ?? "").localeCompare(a[1].started ?? ""))[0];
    const child = current?.[1].child ? byId.get(current[1].child) : undefined;
    const by = fired.get(w.id);
    const dir = w.project ?? child?.meta.dir ?? "";
    const started = steps.map(([, s]) => s.started).filter((x): x is string => !!x).sort()[0] ??
      child?.meta.started ?? new Date(f.now).toISOString();
    const state = stateOfWorkflow(w, byId);
    const updated = f.touched(w.id) ?? started;
    const waiting = steps.flatMap(([, s]) => {
      const c = s.child ? byId.get(s.child) : undefined;
      return c && c.state.phase !== "ended" ? c.state.pending.map((p) => `${c.meta.id}/${p.request}`) : [];
    });
    out.push({
      dir,
      run: {
        id: w.id,
        kind: "workflow",
        profile: child?.meta.profile ?? w.plan.steps.find((s) => s.id === current?.[0])?.profile ?? "",
        ...(child?.meta.provider ? { provider: child.meta.provider } : {}),
        project: projectName(dir, f.home),
        ...(by ? { branch: by.firing.branch } : {}),
        started,
        updated,
        state,
        ...(state === "ended" || state === "failed" ? { ended: updated } : {}),
        tail: child ? tailOf(child.state.said) : [],
        ...(waiting.length ? { waiting } : {}),
        ...(by ? { routine: by.r.name } : {}),
        workflow: {
          name: w.plan.name,
          step: current?.[0] ?? "",
          steps: steps.map(([id, s]) => ({ id, state: s.status })),
        },
        ...(by && f.jobOf(by.firing.id) ? { job: f.jobOf(by.firing.id) } : {}),
      },
    });
  }
  for (const c of children) {
    if (inWorkflow.has(c.meta.id) || c.meta.run) continue;
    const by = fired.get(c.meta.id);
    const state = stateOfChild(c);
    const updated = f.touched(c.meta.id) ?? c.meta.started;
    const pending = c.state.phase === "ended" ? [] : c.state.pending.map((p) => `${c.meta.id}/${p.request}`);
    const dir = c.meta.dir;
    out.push({
      dir: c.meta.project ?? dir,
      run: {
        id: c.meta.id,
        kind: by ? "routine" : "child",
        profile: c.meta.profile,
        ...(c.meta.provider ? { provider: c.meta.provider } : {}),
        project: projectName(c.meta.project ?? dir, f.home),
        ...(by ? { branch: by.firing.branch } : {}),
        ...(titleOf(c.meta.task) ? { title: titleOf(c.meta.task) } : {}),
        started: c.meta.started,
        updated,
        state,
        ...(state === "ended" || state === "failed" ? { ended: updated } : {}),
        tail: tailOf(c.state.said),
        ...(pending.length ? { waiting: pending } : {}),
        ...(by ? { routine: by.r.name } : {}),
        ...(by && f.jobOf(by.firing.id) ? { job: f.jobOf(by.firing.id) } : {}),
      },
    });
  }
  // ended runs of the last week only; live ones before them, so the cap never drops a live one for an old one
  const live = out.filter((x) => x.run.state !== "ended" && x.run.state !== "failed");
  const ended = out.filter((x) =>
    (x.run.state === "ended" || x.run.state === "failed") &&
    f.now - Date.parse(x.run.updated) < ENDED_MS
  )
    .sort((a, b) => b.run.updated.localeCompare(a.run.updated));
  const runs = [...live, ...ended].slice(0, MAX_RUNS);
  for (const x of runs) {
    const repo = x.dir ? f.repoOf(x.dir) : null;
    if (repo) x.run.repo = repo;
    else x.run.noMove ??= "no remote: it cannot move";
    if (!x.run.branch && x.dir && x.run.state !== "ended" && x.run.state !== "failed") {
      const b = f.branchOf(
        x.run.kind === "child" ? children.find((c) => c.meta.id === x.run.id)?.meta.dir ?? x.dir : x.dir,
      );
      if (b) x.run.branch = b;
    }
  }
  return {
    runs,
    // a job placed here runs as a one-shot routine: it is a run, not a routine of the owner's
    routines: routines.filter(({ r }) => !r.job).slice(0, MAX_ROUTINES).map(({ r, st }) => ({
      routine: {
        name: r.name,
        schedule: scheduleOf(r),
        ...(st.next ? { next: st.next } : {}),
        ...(st.lastFired ? { last: st.lastFired } : {}),
        enabled: r.enabled,
      },
      repo: r.project ? f.repoOf(r.project) : null,
    })),
  };
}

/** Pure: what goes out for this machine's setting: each run redacted by its repository's owner; nothing for `off`. */
export function publishable(
  c: ReturnType<typeof collect>,
  mode: RunsMode,
  repos: string[],
  gitHosts: string[],
): { runs: PublishedRun[]; routines: PublishedRoutine[] } {
  if (mode === "off") return { runs: [], routines: [] };
  return {
    runs: c.runs.map((x) => redact(x.run, mode, ownRepo(x.run.repo, repos, gitHosts))),
    routines: c.routines.map((x) => ownRepo(x.repo, repos, gitHosts) ? x.routine : { ...x.routine, name: CLIENT }),
  };
}

// ---------------------------------------------------------------- the phone's stop

/** A stop as the announce's reply carries it. */
export interface Stop {
  run: string;
  expires: string;
  assertion: PasskeyAssertion;
}

/** Pure: the text a stop from the phone signs (the web app's agents-core.ts writes the same). */
export const stopText = (s: { node: string; run: string; expires: string }): string =>
  `agents-multi stop v1\n${canonical({ node: s.node, run: s.run, expires: s.expires })}`;

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

/** The challenge of a stop: SHA-256 of its text. */
export const stopChallenge = (s: { node: string; run: string; expires: string }) => sha256(stopText(s));

/** The key a node remembers a stop by, to refuse it a second time: its challenge. */
export const stopKey = async (s: { node: string; run: string; expires: string }) => b64u(await stopChallenge(s));

const SLACK_MS = 60_000;

/** Why this node must not stop a run on the phone's word, or null when the owner's yes holds: not expired, not
 *  further ahead than ten minutes, from an endorsed, unrevoked passkey whose assertion holds over the stop's text
 *  for THIS node, not used before. */
export async function verifyStop(
  s: Stop,
  self: string,
  ctx: PasskeyCtx,
  seen: Iterable<string>,
): Promise<string | null> {
  const until = Date.parse(s.expires);
  if (!(until > 0)) return "no expiry";
  if (!(ctx.now < until)) return "its approval expired";
  if (until > ctx.now + MAX_AHEAD_MS + SLACK_MS) return "it holds longer than ten minutes";
  const asm = cleanAssertion(s.assertion);
  if (!asm) return "the assertion lacks a part";
  const body = { node: self, run: s.run, expires: s.expires };
  const why = await verifyPasskey(asm, await stopChallenge(body), ctx);
  if (why) return why;
  if ([...seen].includes(await stopKey(body))) return "already used";
  return null;
}

export interface StopResult {
  id: string;
  ok: boolean;
  why?: string;
}

/** Checks each stop and stops what holds: a child at once, a workflow run through its runner. Returns what to
 *  report (`stop:<run>`); `seen` gets the key of each one applied or refused for good. A stop whose passkeys could
 *  not be read is left for the next tick. */
export async function applyStops(
  stops: Stop[],
  self: string,
  seen: string[],
  d: {
    ctx: () => Promise<PasskeyCtx>;
    stop: (run: string) => Promise<void>;
  },
): Promise<StopResult[]> {
  const out: StopResult[] = [];
  for (const s of stops) {
    if (!s || typeof s.run !== "string" || typeof s.expires !== "string") continue;
    const key = await stopKey({ node: self, run: s.run, expires: s.expires });
    if (seen.includes(key)) {
      out.push({ id: `stop:${s.run}`, ok: false, why: "already used" });
      continue;
    }
    let ctx: PasskeyCtx;
    try {
      ctx = await d.ctx();
    } catch {
      continue;
    }
    const why = await verifyStop(s, self, ctx, seen);
    if (why) {
      out.push({ id: `stop:${s.run}`, ok: false, why });
      continue;
    }
    seen.push(key);
    try {
      await d.stop(s.run);
      out.push({ id: `stop:${s.run}`, ok: true });
    } catch (e) {
      out.push({ id: `stop:${s.run}`, ok: false, why: (e as Error).message });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the machine's side of it

async function git(dir: string, args: string[]): Promise<string | null> {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args], stdout: "piped", stderr: "null" }).output()
    .catch(() => null);
  return r?.success ? new TextDecoder().decode(r.stdout).trim() : null;
}

/** what a folder's remote and branch were, a while ago: a git call per folder per minute, not per publish */
const cache = new Map<string, { at: number; v: string | null }>();
async function cached(key: string, ms: number, get: () => Promise<string | null>): Promise<string | null> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.v;
  const v = await get();
  cache.set(key, { at: Date.now(), v });
  return v;
}

const mtime = async (path: string) => (await Deno.stat(path).catch(() => null))?.mtime?.toISOString();

/** Reads this machine's runs and routines as the service is told, for its setting. */
export async function readRuns(
  cfg: NodeConfig,
  jobs: Record<string, string> = {},
  runs = runsDir(),
): Promise<{ runs: PublishedRun[]; routines: PublishedRoutine[] }> {
  const mode: RunsMode = cfg.runs ?? "full";
  if (mode === "off") return { runs: [], routines: [] };
  const children = await listChildren(runs);
  const workflows = await listRuns(runs);
  const routines: { r: Routine; st: RoutineState }[] = [];
  for (const r of await listRoutines()) routines.push({ r, st: await readState(r.id) });
  const touched = new Map<string, string>();
  for (const c of children) {
    const t = await mtime(`${runs}/${c.meta.id}/out.jsonl`);
    if (t) touched.set(c.meta.id, t);
  }
  for (const w of workflows) {
    const t = await mtime(`${runs}/runs/${w.id}/state.json`);
    if (t) touched.set(w.id, t);
  }
  const dirs = new Set<string>();
  for (const c of children) dirs.add(c.meta.project ?? c.meta.dir).add(c.meta.dir);
  for (const w of workflows) if (w.project) dirs.add(w.project);
  for (const { r } of routines) if (r.project) dirs.add(r.project);
  const repo = new Map<string, string | null>(), branch = new Map<string, string | null>();
  for (const d of dirs) {
    if (!d) continue;
    repo.set(d, await cached(`r:${d}`, 300_000, () => remoteOf(d)));
    if (mode === "full") branch.set(d, await cached(`b:${d}`, 60_000, () => git(d, ["branch", "--show-current"])));
  }
  const c = collect(children, workflows, routines, {
    home: HOME,
    now: Date.now(),
    touched: (id) => touched.get(id),
    repoOf: (d) => repo.get(d) ?? null,
    branchOf: (d) => branch.get(d) || undefined,
    jobOf: (id) => jobs[id] || undefined,
  });
  const gitHosts = (cfg as NodeConfig & { gitHosts?: string[] }).gitHosts ?? [];
  return publishable(c, mode, cfg.repos, gitHosts);
}

export const putRuns = (s: Service, body: Record<string, unknown>) =>
  s.call<{ ok: boolean }>("PUT", "/api/node/runs", body);

let lastSent = "", lastAt = 0, lastJobs: Record<string, string> = {};
/** stop results not yet told: they go with the next publish */
let unreported: StopResult[] = [];

/** Tells the service this machine's runs: when they changed since the last time and not sooner than 2 s after it,
 *  or `force`d (each announce does, so a service that lost them learns them again). `jobs`: the service's job of
 *  each followed firing (agentd's state), kept for the publishes that do not carry it. */
export async function publishRuns(
  cfg: NodeConfig,
  svc: Service,
  o: { force?: boolean; jobs?: Record<string, string> } = {},
): Promise<number> {
  if (o.jobs) lastJobs = o.jobs;
  const now = Date.now();
  if (!o.force && now - lastAt < PUBLISH_MS && !unreported.length) return 0;
  const body = await readRuns(cfg, lastJobs);
  const json = JSON.stringify(body);
  if (!o.force && json === lastSent && !unreported.length) return body.runs.length;
  const results = unreported;
  await putRuns(svc, { ...body, ...(results.length ? { results } : {}) });
  unreported = unreported.filter((r) => !results.includes(r));
  lastSent = json;
  lastAt = now;
  return body.runs.length;
}

export interface StopState {
  done: string[];
}

export const stopStateFile = (runs = runsDir()) => `${runs}/node/stops.json`;

async function readStopState(file = stopStateFile()): Promise<StopState> {
  const s = await Deno.readTextFile(file).then(JSON.parse).catch(() => null) as Partial<StopState> | null;
  return { done: Array.isArray(s?.done) ? s.done.filter((x): x is string => typeof x === "string") : [] };
}

async function writeStopState(st: StopState, file = stopStateFile()) {
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  const tmp = `${file}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify({ done: st.done.slice(-500) }, null, 2) + "\n");
  await Deno.rename(tmp, file);
}

/** The phone's stops from the announce's reply: checked here, applied, reported with the next publish, and the
 *  owner told of a refusal. */
export async function handleStops(
  cfg: NodeConfig,
  svc: Service,
  stops: Stop[],
  self: string,
  ctx: () => Promise<PasskeyCtx>,
  o: { log: (s: string) => void; notify: (title: string, body: string) => void },
): Promise<void> {
  if (!stops.length) return;
  const st = await readStopState();
  const workflows = new Set((await listRuns()).map((w) => w.id));
  const results = await applyStops(stops, self, st.done, {
    ctx,
    // at once, as the person pressed it: not after the turn the child is in
    stop: (run) => workflows.has(run) ? answerRun(run, "stop") : stopChild(run, true),
  });
  await writeStopState(st);
  for (const r of results) {
    if (r.ok) o.log(`node: the phone stopped ${r.id.slice(5)}`);
    else {
      o.log(`node: the phone's stop of ${r.id.slice(5)} refused: ${r.why}`);
      o.notify(`A stop from the phone was refused on ${self}`, `${r.id.slice(5)}: ${r.why}`);
    }
  }
  unreported.push(...results);
  await publishRuns(cfg, svc, { force: true }).catch((e) => o.log(`node: runs: ${(e as Error).message}`));
}
