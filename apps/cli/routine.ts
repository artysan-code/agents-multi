// routine.ts — `agents routine`: the schedule of unattended jobs (shared/mcp/lib/routines.ts, ADR 0010).
// add/list/rm only write and read the routines' files; the console's backend fires them (`run` asks it to,
// or `run --now` starts one here). The same operations are the `routine_*` tools of the agents server.

import { type Scope, scopeOf } from "../../shared/mcp/lib/agents.ts";
import { parseAt } from "../../shared/mcp/lib/cron.ts";
import {
  addRoutine,
  fire,
  listRoutines,
  readRoutine,
  readState,
  removeRoutine,
  requestFire,
  type Routine,
  type Trigger,
  writeState,
} from "../../shared/mcp/lib/routines.ts";
import { loadPolicy } from "../../shared/mcp/lib/policy.ts";

const USAGE =
  `agents routine add [--name n] (--cron "m h dom mon dow" | --at <2026-10-15T02:00|02:00|+90m> | --on run-done|run-failed [--plan name] | --on limit-reset [--account profile[/provider]])
                   [--workflow <plan.json>] [--profile p [--provider codex]] [--folder dir] [--model m] [--grace minutes] [task…]
                                               without --profile the project's default account runs it (agents account default)
                                               schedules an unattended job in a worktree of the repository (docs/adr/0010)
agents routine list [--project] [--all]        the routines of your project: trigger, next time, what it started
agents routine rm <id>                         removes it (what it started stays)
agents routine run <id> [--now]                asks the console to fire it now (--now: starts it from here)

A routine's children belong to its project with no coordinator: a coordinator of the project sees them as
orphans and may adopt and answer them. They work on agent/<run> in a worktree beside the repository, and may
push that branch and the development branch, never main/release (the repository's run policy).`;

export const describeTrigger = (t: Trigger) =>
  t.kind === "cron"
    ? `cron ${t.expr}`
    : t.kind === "at"
    ? `at ${t.at}`
    : `on ${t.on}${t.on === "limit-reset" ? (t.account ? ` (${t.account})` : "") : t.plan ? ` (${t.plan})` : ""}`;

const mine = (r: Routine, scope: Scope) => r.project === scope.project;

export async function routineCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const opt = (name: string) => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    rest.splice(i, 2);
    return v;
  };
  const has = (name: string) => {
    const i = rest.indexOf(name);
    if (i >= 0) rest.splice(i, 1);
    return i >= 0;
  };
  try {
    switch (sub) {
      case "add": {
        const cron = opt("--cron"), at = opt("--at"), on = opt("--on"), plan = opt("--plan");
        const workflow = opt("--workflow"), profile = opt("--profile"), model = opt("--model");
        const provider = opt("--provider"), account = opt("--account");
        const name = opt("--name"), folder = opt("--folder") ?? Deno.cwd(), grace = opt("--grace");
        const triggers = [cron, at, on].filter((x) => x !== undefined).length;
        if (triggers !== 1 || (provider !== undefined && provider !== "claude" && provider !== "codex")) break;
        const trigger: Trigger = cron !== undefined
          ? { kind: "cron", expr: cron }
          : at !== undefined
          ? { kind: "at", at: parseAt(at, new Date()) }
          : on === "limit-reset"
          ? { kind: "event", on, ...(account ? { account } : {}) }
          : { kind: "event", on: on as "run-done" | "run-failed", ...(plan ? { plan } : {}) };
        const task = rest.join(" ");
        const scope = await scopeOf();
        const r = await addRoutine({
          name,
          trigger,
          folder,
          grace: grace === undefined ? undefined : Number(grace),
          action: workflow ? { kind: "workflow", plan: workflow, task: task || undefined } : {
            kind: "agent",
            profile: profile ?? "",
            ...(provider === "codex" ? { provider } : {}),
            task,
            model,
          },
          by: scope.me,
        });
        console.log(`${r.id}  ${describeTrigger(r.trigger)}  ${r.project}`);
        return 0;
      }
      case "list": {
        const scope = await scopeOf({ all: has("--all"), project: has("--project") });
        const all = scope.view === "all";
        const list = (await listRoutines()).filter((r) => all || r.project === scope.project);
        if (!list.length) console.log("no routines");
        for (const r of list) {
          const st = await readState(r.id);
          const live = st.runs.filter((f) => !f.ended).length;
          const bits = [
            describeTrigger(r.trigger),
            st.status ? st.status : st.next ? `next ${st.next}` : "",
            st.queued ? "waiting for room" : "",
            live ? `${live} running` : "",
            st.lastFired ? `last ${st.lastFired}` : "",
            st.lastError ? `error: ${st.lastError}` : "",
          ].filter(Boolean);
          console.log(`${r.id}  ${r.name}  ${bits.join(" · ")}`);
          for (const f of st.runs.slice(-3)) {
            console.log(`    ${f.id}  ${f.branch}${f.ended ? " (ended)" : ""}  ${f.child ?? f.run}`);
          }
        }
        return 0;
      }
      case "rm": {
        const r = rest[0] ? await readRoutine(rest[0]) : null;
        if (!r) throw new Error(rest[0] ? `no routine ${rest[0]}` : "which routine?");
        if (!mine(r, await scopeOf())) throw new Error("not a routine of this project");
        await removeRoutine(r.id);
        console.log(`removed ${r.id}`);
        return 0;
      }
      case "run": {
        const now = has("--now");
        const r = rest[0] ? await readRoutine(rest[0]) : null;
        if (!r) throw new Error(rest[0] ? `no routine ${rest[0]}` : "which routine?");
        if (!mine(r, await scopeOf())) throw new Error("not a routine of this project");
        if (!now) {
          await requestFire(r.id);
          console.log(`${r.id}: the console starts it within 15 seconds`);
          return 0;
        }
        const f = await fire(r, await loadPolicy(r.project));
        const st = await readState(r.id);
        await writeState(r.id, { ...st, runs: [...st.runs.slice(-19), f], lastFired: f.at });
        console.log(`started ${f.child ?? f.run} on ${f.branch} in ${f.worktree}`);
        return 0;
      }
    }
  } catch (e) {
    console.error(`agents routine ${sub}: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}
