// routines.ts — a persistent schedule of unattended jobs (ADR 0010). A routine is a file in the hub's
// state (`<runs>/routines/<id>.json`): a trigger (cron, a one-shot `at`, or an event of a workflow run),
// an action (a child, or a saved plan), a folder. The console's backend ticks over them
// (apps/cli/console/routines.ts); the CLI and the MCP tools only write and read the files, so the tools'
// narrow permissions are enough. A fired routine works in its own worktree under the repository's run
// policy (policy.ts) and belongs to its project, with no coordinator: any coordinator of the project
// sees it as an orphan and may adopt it (ADR 0005).

import { nextFire, parseCron } from "./cron.ts";
import {
  type Coordinator,
  listChildren,
  type Owner,
  projectOf,
  readChild,
  runsDir,
  startChild,
  stopChild,
} from "./agents.ts";
import { DENY_TOOLS, isolate, loadPolicy, type Policy } from "./policy.ts";
import { listRuns, type Plan, readRun, startRun } from "./runs.ts";

export type Trigger =
  | { kind: "cron"; expr: string }
  | { kind: "at"; at: string }
  | { kind: "event"; on: "run-done" | "run-failed"; plan?: string };

export type Action =
  | { kind: "agent"; profile: string; task: string; model?: string }
  | { kind: "workflow"; plan: string; task?: string };

export interface Routine {
  id: string;
  name: string;
  trigger: Trigger;
  action: Action;
  /** the folder the run works in (inside a git repository under home) */
  folder: string;
  /** the project (main repository root) of `folder` */
  project: string;
  /** minutes a firing may be late and still run: past it the routine is marked missed. Default by trigger. */
  grace?: number;
  enabled: boolean;
  created: string;
  /** the coordinator that scheduled it, as a note */
  by?: Coordinator;
}

/** What a firing started. */
export interface Fired {
  /** the run id: the branch is `agent/<id>` */
  id: string;
  at: string;
  child?: string;
  run?: string;
  branch: string;
  worktree: string;
  /** requests already announced to the owner */
  told: string[];
  ended?: string;
}

export interface RoutineState {
  /** the next time it is due (cron, at) */
  next?: string;
  /** an `at` routine, once it has been dealt with */
  status?: "fired" | "missed";
  lastFired?: string;
  /** a firing waiting for room under the policy's concurrency */
  queued?: string;
  /** workflow runs already seen (event triggers) */
  seen?: string[];
  runs: Fired[];
  lastError?: string;
}

export const DEFAULT_GRACE = { cron: 15, at: 360, event: 60 };
export const routinesDir = (runs = runsDir()) => `${runs}/routines`;
const ID = /^[a-z0-9][a-z0-9-]{0,60}$/;
export const validRoutineId = (id: string) => ID.test(id);

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);

/** Pure: what is wrong with a routine, nothing when it can be kept. */
export function routineErrors(r: Routine): string[] {
  const errs: string[] = [];
  const t = r.trigger;
  if (t?.kind === "cron") {
    try {
      parseCron(t.expr);
    } catch (e) {
      errs.push((e as Error).message);
    }
  } else if (t?.kind === "at") {
    if (Number.isNaN(Date.parse(t.at))) errs.push("at is not a date");
  } else if (t?.kind === "event") {
    if (t.on !== "run-done" && t.on !== "run-failed") errs.push("event is run-done or run-failed");
  } else errs.push("trigger is cron, at or event");
  if (r.action?.kind === "agent") {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(r.action.profile ?? "")) errs.push("a profile is needed");
    if (!r.action.task?.trim()) errs.push("say what the child has to do");
    if (r.action.model && !/^[a-z0-9.\[\]-]+$/i.test(r.action.model)) errs.push("not a model name");
  } else if (r.action?.kind === "workflow") {
    if (!r.action.plan?.trim()) errs.push("a plan file is needed");
  } else errs.push("action is agent or workflow");
  if (!r.folder?.trim()) errs.push("a folder is needed");
  if (r.grace !== undefined && !(r.grace >= 0)) errs.push("grace is a number of minutes");
  return errs;
}

/** Pure: what the tick does with a time-triggered routine at `now`: `fire` (due, within its grace),
 *  `missed` (due, but later than its grace), `wait`; and the next due time to keep (cron). An `at` routine
 *  that is missed is never run late — a night job does not start at breakfast; the owner is told. */
export function due(r: Routine, st: RoutineState, now: Date): { act: "fire" | "missed" | "wait"; next?: string } {
  const t = r.trigger;
  if (!r.enabled) return { act: "wait", next: st.next };
  if (t.kind === "at") {
    if (st.status) return { act: "wait" };
    const late = now.getTime() - Date.parse(t.at);
    if (late < 0) return { act: "wait", next: t.at };
    return { act: late <= (r.grace ?? DEFAULT_GRACE.at) * 6e4 ? "fire" : "missed" };
  }
  if (t.kind === "cron") {
    const next = st.next ?? nextFire(t.expr, now)?.toISOString();
    if (!next) return { act: "wait" };
    if (Date.parse(next) > now.getTime()) return { act: "wait", next };
    const late = now.getTime() - Date.parse(next);
    return {
      act: late <= (r.grace ?? DEFAULT_GRACE.cron) * 6e4 ? "fire" : "missed",
      next: nextFire(t.expr, now)?.toISOString(),
    };
  }
  return { act: "wait" };
}

/** Pure: the workflow runs an event routine fires for: ended ones it has not seen, of its project, by
 *  plan name when it names one. `run-done` is a run that finished all its steps, `run-failed` one that was
 *  stopped (a step failed and the owner or the runner stopped it). */
export function eventRuns(
  r: Routine,
  runs: { id: string; project?: string; plan: { name: string }; status: string }[],
  seen: string[],
): string[] {
  const t = r.trigger;
  if (t.kind !== "event" || !r.enabled) return [];
  const want = t.on === "run-done" ? "done" : "stopped";
  return runs
    .filter((x) =>
      x.status === want && !seen.includes(x.id) && x.project === r.project && (!t.plan || x.plan.name === t.plan)
    )
    .map((x) => x.id);
}

// ---------------------------------------------------------------- the store

const readJson = <T>(f: string) => Deno.readTextFile(f).then((t) => JSON.parse(t) as T).catch(() => null);
async function writeJson(f: string, v: unknown) {
  await Deno.mkdir(f.slice(0, f.lastIndexOf("/")), { recursive: true });
  const tmp = `${f}.${crypto.randomUUID().slice(0, 6)}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(v, null, 2) + "\n");
  await Deno.rename(tmp, f);
}

export async function listRoutines(dir = routinesDir()): Promise<Routine[]> {
  const out: Routine[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".json") || e.name.endsWith(".state.json")) continue;
      const r = await readJson<Routine>(`${dir}/${e.name}`);
      if (r && validRoutineId(r.id)) out.push(r);
    }
  } catch { /* none yet */ }
  return out.sort((a, b) => a.created.localeCompare(b.created));
}

export const readRoutine = async (id: string, dir = routinesDir()) =>
  validRoutineId(id) ? await readJson<Routine>(`${dir}/${id}.json`) : null;

export async function readState(id: string, dir = routinesDir()): Promise<RoutineState> {
  return (await readJson<RoutineState>(`${dir}/${id}.state.json`)) ?? { runs: [] };
}

export const writeState = (id: string, st: RoutineState, dir = routinesDir()) =>
  writeJson(`${dir}/${id}.state.json`, st);

export interface NewRoutine {
  name?: string;
  trigger: Trigger;
  action: Action;
  folder: string;
  grace?: number;
  by?: Coordinator;
}

/** Checks and stores a routine. The folder must be a git repository under home: a run needs a worktree. */
export async function addRoutine(
  i: NewRoutine,
  dir = routinesDir(),
  home = Deno.env.get("HOME") ?? "",
): Promise<Routine> {
  const given = i.folder.replace(/^~(?=\/|$)/, home);
  const folder = await Deno.realPath(given).catch(() => null);
  if (!folder || !(await Deno.stat(folder)).isDirectory) throw new Error(`no folder ${given}`);
  const realHome = await Deno.realPath(home).catch(() => home);
  if (!realHome || !folder.startsWith(`${realHome}/`)) throw new Error("the folder must be under the home folder");
  const project = await projectOf(folder);
  if (!(await Deno.stat(`${project}/.git`).catch(() => null))) {
    throw new Error("the folder must be in a git repository: a run works on its own branch in its own worktree");
  }
  const label = i.name?.trim() ||
    (i.action.kind === "agent" ? i.action.task : i.action.plan.split("/").pop() ?? "routine");
  const r: Routine = {
    id: `${slug(label) || "routine"}-${crypto.randomUUID().slice(0, 4)}`,
    name: i.name?.trim() || label.slice(0, 60),
    trigger: i.trigger,
    action: i.action,
    folder,
    project,
    ...(i.grace !== undefined ? { grace: i.grace } : {}),
    enabled: true,
    created: new Date().toISOString(),
    ...(i.by ? { by: i.by } : {}),
  };
  const errs = routineErrors(r);
  if (errs.length) throw new Error(errs.join("; "));
  await writeJson(`${dir}/${r.id}.json`, r);
  await writeState(r.id, { runs: [], ...(r.trigger.kind === "at" ? { next: r.trigger.at } : {}) }, dir);
  return r;
}

/** Removes a routine and its state. What it started stays (worktrees, branches, children). */
export async function removeRoutine(id: string, dir = routinesDir()): Promise<void> {
  if (!(await readRoutine(id, dir))) throw new Error(`no routine ${id}`);
  for (const f of [`${id}.json`, `${id}.state.json`, `${id}.fire`]) await Deno.remove(`${dir}/${f}`).catch(() => {});
}

/** Asks the console to fire a routine now (a file it picks up on its next tick). */
export async function requestFire(id: string, dir = routinesDir()): Promise<void> {
  if (!(await readRoutine(id, dir))) throw new Error(`no routine ${id}`);
  await Deno.writeTextFile(`${dir}/${id}.fire`, new Date().toISOString());
}

// ---------------------------------------------------------------- firing

/** Pure: the first message of an unattended child: where it is, what it may and may not do. */
export function preamble(r: Routine, id: string, branch: string, p: Policy, worktree: string): string {
  const push = p.push
    ? `may push ${[branch, ...p.pushBranches].join(" and ")} and nothing else (${
      p.protectedBranches.join(", ")
    } are refused by a hook)`
    : "may not push";
  return [
    `[routine ${r.name} · run ${id}] You work unattended, in ${worktree}, on the branch ${branch}, a worktree of its own.`,
    `You ${p.commit ? "may commit" : "may not commit"} and ${push}. Anything outward (deploy, send, delete, spend) ` +
    "waits for the owner: ask for it and wait, do not look for a way round.",
    "Say in your last message what you did and what is left.",
  ].join("\n");
}

/** Pure: a plan for a run in a worktree: its folders move into it. A step's own folder must be inside the
 *  routine's repository; `{{task}}` in a prompt becomes the routine's task. */
export function planIn(
  plan: Plan,
  project: string,
  worktree: string,
  task?: string,
  home = Deno.env.get("HOME") ?? "",
): Plan {
  const move = (f: string) => {
    const abs = f.replace(/^~(?=\/|$)/, home);
    if (abs !== project && !abs.startsWith(`${project}/`)) {
      throw new Error(`a step works outside the routine's repository (${f}): not in an unattended run`);
    }
    return worktree + abs.slice(project.length);
  };
  return {
    ...plan,
    folder: plan.folder ? move(plan.folder) : worktree,
    steps: plan.steps.map((s) => ({
      ...s,
      ...(s.folder ? { folder: move(s.folder) } : {}),
      prompt: task ? s.prompt.replaceAll("{{task}}", task) : s.prompt,
    })),
  };
}

/** Starts a routine's work now: its worktree and branch under the policy, then the child or the run, as
 *  the project's with no coordinator. Returns what it started. */
export async function fire(r: Routine, p?: Policy): Promise<Fired> {
  const policy = p ?? await loadPolicy(r.project);
  const id = `${slug(r.name) || "routine"}-${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "")}-${
    crypto.randomUUID().slice(0, 3)
  }`;
  const iso = await isolate(r.project, id, policy);
  const owner: Owner = { project: r.project };
  const where = iso.path + r.folder.slice(r.project.length);
  const out: Fired = { id, at: new Date().toISOString(), branch: iso.branch, worktree: iso.path, told: [] };
  if (r.action.kind === "agent") {
    const m = await startChild({
      profile: r.action.profile,
      dir: where,
      task: `${preamble(r, id, iso.branch, policy, iso.path)}\n\n${r.action.task}`,
      model: r.action.model,
      owner,
      disallowedTools: DENY_TOOLS,
    });
    out.child = m.id;
  } else {
    const home = Deno.env.get("HOME") ?? "";
    const file = r.action.plan.replace(/^~(?=\/|$)/, home);
    const plan = JSON.parse(await Deno.readTextFile(file.startsWith("/") ? file : `${r.folder}/${file}`)) as Plan;
    out.run = await startRun(planIn(plan, r.project, iso.path, r.action.task), undefined, undefined, owner);
  }
  return out;
}

// ---------------------------------------------------------------- the tick

/** What a firing is waiting for from the owner, and whether it has ended. */
export interface Watch {
  requests: { id: string; what: string }[];
  ended: boolean;
  error?: string;
}

export async function watchFired(f: Fired): Promise<Watch> {
  const children = f.child
    ? [await readChild(f.child)]
    : f.run
    ? (await listChildren()).filter((c) => c.meta.run?.id === f.run)
    : [];
  const requests = children.flatMap((c) =>
    c?.state.pending.map((p) => ({ id: `${c.meta.id}:${p.request}`, what: p.what })) ?? []
  );
  let ended = children.length > 0 && children.every((c) => !c || c.state.phase === "ended");
  const error = children.map((c) => c?.state.error).find(Boolean) || undefined;
  if (f.run) {
    const run = await readRun(f.run);
    if (run) {
      for (const [k, s] of Object.entries(run.state.steps)) {
        if (s.status === "confirm" || s.status === "failed") {
          requests.push({ id: `${f.run}:${k}:${s.status}`, what: `step ${k} is ${s.status}` });
        }
      }
      ended = run.state.status !== "running";
    }
  }
  return { requests, ended, error };
}

/** Stops what a firing started: its children now, a run through its control file. */
export async function stopFired(f: Fired): Promise<void> {
  if (f.child) await stopChild(f.child, true);
  if (f.run) {
    await Deno.writeTextFile(
      `${runsDir()}/runs/${f.run}/control.jsonl`,
      JSON.stringify({ at: new Date().toISOString(), choice: "stop" }) + "\n",
      { append: true },
    ).catch(() => {});
    for (const c of (await listChildren()).filter((c) => c.meta.run?.id === f.run)) await stopChild(c.meta.id, true);
  }
}

/** The tick's seams: tests give fakes, the console the defaults. */
export interface Deps {
  now: () => Date;
  fire: (r: Routine, p: Policy) => Promise<Fired>;
  policy: (project: string) => Promise<Policy>;
  watch: (f: Fired) => Promise<Watch>;
  stop: (f: Fired) => Promise<void>;
  /** workflow runs, for the event triggers */
  runs: () => Promise<{ id: string; project?: string; plan: { name: string }; status: string }[]>;
  notify: (title: string, body: string) => void | Promise<void>;
  log: (s: string) => void;
}

export const realDeps = (notify: Deps["notify"], log: Deps["log"]): Deps => ({
  now: () => new Date(),
  fire,
  policy: (project) => loadPolicy(project),
  watch: watchFired,
  stop: stopFired,
  runs: async () =>
    (await listRuns()).map((x) => ({ id: x.id, project: x.project, plan: x.plan, status: x.state.status })),
  notify,
  log,
});

/** One pass over the routines: announce what waits for the owner, stop what ran too long, fire what is
 *  due (room under the policy's concurrency permitting), mark what was missed. State is written back
 *  only when it changed. */
export async function tick(dir: string, deps: Deps): Promise<void> {
  const routines = await listRoutines(dir);
  const now = deps.now();
  const states = new Map<string, RoutineState>();
  for (const r of routines) states.set(r.id, await readState(r.id, dir));
  const policies = new Map<string, Policy>();
  const policyOf = async (project: string) =>
    policies.get(project) ?? (policies.set(project, await deps.policy(project)), policies.get(project)!);
  const ours = new Set([...states.values()].flatMap((s) => s.runs.map((f) => f.run).filter(Boolean) as string[]));
  const runs = (await deps.runs()).filter((x) => !ours.has(x.id));
  let running = 0;
  for (const r of routines) {
    const st = states.get(r.id)!;
    const before = JSON.stringify(st);
    for (const f of st.runs.filter((f) => !f.ended)) {
      const w = await deps.watch(f);
      for (const q of w.requests.filter((q) => !f.told.includes(q.id))) {
        f.told.push(q.id);
        await deps.notify(
          `Routine ${r.name} waits for you`,
          `${q.what}\nA coordinator of the project can adopt it and answer.`,
        );
      }
      const p = await policyOf(r.project);
      if (w.ended) {
        f.ended = now.toISOString();
        await deps.notify(`Routine ${r.name} finished`, `Branch ${f.branch}${w.error ? `\n${w.error}` : ""}`);
      } else if (now.getTime() - Date.parse(f.at) > p.timeoutMin * 6e4) {
        await deps.stop(f);
        f.ended = now.toISOString();
        await deps.notify(
          `Routine ${r.name} timed out`,
          `Stopped after ${p.timeoutMin} minutes; branch ${f.branch} keeps its commits.`,
        );
      } else running++;
    }
    if (JSON.stringify(st) !== before) await writeState(r.id, st, dir);
  }
  for (const r of routines) {
    const st = states.get(r.id)!;
    const before = JSON.stringify(st);
    let go = false;
    const fireFile = `${dir}/${r.id}.fire`;
    if (await Deno.stat(fireFile).then(() => true, () => false)) {
      await Deno.remove(fireFile).catch(() => {});
      go = true;
    }
    if (r.trigger.kind === "event") {
      // what ended before the routine looked is history, not an event
      st.seen ??= runs.filter((x) => x.status !== "running").map((x) => x.id);
      const fresh = eventRuns(r, runs, st.seen);
      if (fresh.length) {
        st.seen = [...st.seen, ...fresh].slice(-300);
        go = true;
      }
    } else {
      const d = due(r, st, now);
      if (d.next) st.next = d.next;
      if (d.act === "missed") {
        if (r.trigger.kind === "at") {
          st.status = "missed";
          await deps.notify(
            `Routine ${r.name} missed`,
            `It was due ${r.trigger.at}, the console was not running; it was not started.`,
          );
        } else deps.log(`routine ${r.id}: a firing went by while the console was down, skipped`);
      } else if (d.act === "fire") {
        go = true;
        if (r.trigger.kind === "at") st.status = "fired";
      }
    }
    if (st.queued && !go) {
      if (now.getTime() - Date.parse(st.queued) > (r.grace ?? DEFAULT_GRACE[r.trigger.kind]) * 6e4) {
        delete st.queued;
        await deps.notify(
          `Routine ${r.name} missed`,
          "There was no room for it under the policy's concurrency before its grace ran out.",
        );
      } else go = true;
    }
    if (go) {
      const p = await policyOf(r.project);
      if (running >= p.maxConcurrent) {
        st.queued ??= now.toISOString();
        deps.log(`routine ${r.id}: waits for room (${running}/${p.maxConcurrent} running)`);
      } else {
        try {
          const f = await deps.fire(r, p);
          st.runs = [...st.runs.slice(-19), f];
          st.lastFired = f.at;
          delete st.queued;
          delete st.lastError;
          running++;
          deps.log(`routine ${r.id}: started ${f.child ?? f.run} on ${f.branch}`);
        } catch (e) {
          st.lastError = (e as Error).message;
          delete st.queued;
          await deps.notify(`Routine ${r.name} failed to start`, st.lastError);
        }
      }
    }
    if (JSON.stringify(st) !== before) await writeState(r.id, st, dir);
  }
}

/** Starts the backend's routine loop; the returned function stops it. */
export function startRoutines(notify: Deps["notify"], log: Deps["log"] = console.log, everyMs = 15_000): () => void {
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await tick(routinesDir(), realDeps(notify, log));
    } catch (e) {
      log(`routines: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  }, everyMs);
  return () => clearInterval(t);
}
