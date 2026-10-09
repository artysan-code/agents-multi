// run.ts — `agents run`: the hub's workflows from a terminal (shared/mcp/lib/runs.ts). Start one from a
// plan, see them, answer a step that waits, stop one; `drive` is the runner itself, which `start` launches.

import {
  answerRun,
  type Choice,
  drive,
  listRuns,
  type Plan,
  readRun,
  runEvents,
  spawnRunner,
  startRun,
} from "../../shared/mcp/lib/runs.ts";

const USAGE = `agents run start <plan.json>                  a workflow run from its plan (docs/adr/0005)
agents run list                               every run, its steps' state
agents run status <id>                        a run in full, with what happened
agents run answer <id> [step] go|retry|skip|stop   the owner's decision (stop without a step: the whole run)
agents run resume <id>                        starts its runner again, when it is gone
agents run drive <id>                         the runner itself (start launches it)`;

export async function runCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "start": {
        if (!rest[0]) break;
        const plan = JSON.parse(await Deno.readTextFile(rest[0])) as Plan;
        console.log(`started ${await startRun(plan)}`);
        return 0;
      }
      case "list": {
        const all = await listRuns();
        if (!all.length) console.log("no runs");
        for (const r of all) {
          const steps = Object.entries(r.state.steps).map(([k, v]) => `${k}:${v.status}`).join(" ");
          console.log(`${r.id}  ${r.state.status}${r.alive ? "" : " (no runner)"}  ${steps}`);
        }
        return 0;
      }
      case "status": {
        const r = rest[0] ? await readRun(rest[0]) : null;
        if (!r) break;
        console.log(JSON.stringify({ ...r, events: await runEvents(r.id) }, null, 2));
        return 0;
      }
      case "answer": {
        const choice = rest.pop() as Choice;
        const [id, step] = rest;
        if (!id || !["go", "retry", "skip", "stop"].includes(choice)) break;
        await answerRun(id, choice, step);
        console.log(`${choice} → ${id}${step ? `/${step}` : ""}`);
        return 0;
      }
      case "resume": {
        const r = rest[0] ? await readRun(rest[0]) : null;
        if (!r) break;
        if (r.alive || r.state.status !== "running") {
          console.log(r.alive ? `${r.id} has its runner` : `${r.id} is ${r.state.status}`);
          return 0;
        }
        await spawnRunner(r.id);
        console.log(`resumed ${r.id}`);
        return 0;
      }
      case "drive": {
        if (!rest[0]) break;
        console.log(`${rest[0]}: ${await drive(rest[0])}`);
        return 0;
      }
    }
  } catch (e) {
    console.error(`agents run ${sub}: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}
