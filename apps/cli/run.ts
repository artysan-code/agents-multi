// run.ts — `agents run`: the hub's workflows from a terminal (shared/mcp/lib/runs.ts). Start one from a
// plan, see them, answer a step that waits, stop one; `drive` is the runner itself, which `start` launches.

import {
  adoptRun,
  answerRun,
  type Choice,
  drive,
  ensureRunner,
  listRuns,
  loadWorkflow,
  type Plan,
  runEvents,
  runIn,
  savedWorkflows,
  saveWorkflow,
  startRun,
} from "../../shared/mcp/lib/runs.ts";
import { ownerOf, scopeOf } from "../../shared/mcp/lib/agents.ts";

const USAGE =
  `agents run start <plan.json|name> [--var k=v]  a workflow run from its plan, or from a saved workflow by name
agents run save <plan.json> <name> "<when to use it>" [--user|--folder <dir>] [--overwrite]   saves a plan as a skill
agents run saved [<folder>]                   the saved workflows a folder can use (the project's wins)
agents run list [--project] [--all]           your session's runs (and the project's orphans), their steps' state
agents run status <id> [--project] [--all]    a run in full, with what happened (the others': read-only)
agents run adopt <id>                         takes an orphan run of this project (and its children): its coordinator is gone
agents run answer <id> [step] go|retry|skip|stop   the owner's decision (stop without a step: the whole run)
agents run resume <id>                        starts its runner again, when it is gone
agents run drive <id>                         the runner itself (start launches it)`;

export async function runCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const has = (name: string) => {
    const i = rest.indexOf(name);
    if (i >= 0) rest.splice(i, 1);
    return i >= 0;
  };
  const flags = () => {
    has("--mine"); // the default now, still accepted
    return { all: has("--all"), project: has("--project") };
  };
  try {
    switch (sub) {
      case "start": {
        const vars: Record<string, string> = {};
        for (let i = rest.indexOf("--var"); i >= 0; i = rest.indexOf("--var")) {
          const [k, ...v] = (rest.splice(i, 2)[1] ?? "").split("=");
          vars[k] = v.join("=");
        }
        if (!rest[0]) break;
        const file = await Deno.readTextFile(rest[0]).catch(() => null);
        const plan = file === null ? (await loadWorkflow(rest[0], Deno.cwd(), vars)).plan : JSON.parse(file) as Plan;
        console.log(`started ${await startRun(plan, undefined, undefined, ownerOf(await scopeOf()))}`);
        return 0;
      }
      case "save": {
        const user = has("--user");
        const overwrite = has("--overwrite");
        const fi = rest.indexOf("--folder");
        const folder = fi >= 0 ? rest.splice(fi, 2)[1] : user ? undefined : Deno.cwd();
        const [file, name, description] = rest;
        if (!file || !name || !description) break;
        const plan = JSON.parse(await Deno.readTextFile(file)) as Plan;
        console.log(
          `saved ${await saveWorkflow({
            name,
            description,
            plan,
            scope: user ? "user" : "project",
            folder,
            overwrite,
          })}`,
        );
        return 0;
      }
      case "saved": {
        const all = await savedWorkflows(rest[0] ?? Deno.cwd());
        if (!all.length) console.log("no saved workflows");
        for (const w of all) console.log(`${w.name}  [${w.scope}]  ${w.description}`);
        return 0;
      }
      case "list": {
        const all = await listRuns(undefined, await scopeOf(flags()));
        if (!all.length) console.log("no runs");
        for (const r of all) {
          const steps = Object.entries(r.state.steps).map(([k, v]) => `${k}:${v.status}`).join(" ");
          const mark = r.access === "orphan"
            ? " [orphan]"
            : r.access === "peer"
            ? " [other session]"
            : r.access === "other"
            ? " [other project]"
            : "";
          console.log(`${r.id}  ${r.state.status}${r.alive ? "" : " (no runner)"}${mark}  ${steps}`);
        }
        return 0;
      }
      case "status": {
        if (!rest[0]) break;
        const r = await runIn(rest[0], await scopeOf(flags()));
        console.log(JSON.stringify({ ...r, events: await runEvents(r.id) }, null, 2));
        return 0;
      }
      case "answer": {
        const choice = rest.pop() as Choice;
        const [id, step] = rest;
        if (!id || !["go", "retry", "skip", "stop"].includes(choice)) break;
        await answerRun(id, choice, step, undefined, await scopeOf());
        console.log(`${choice} → ${id}${step ? `/${step}` : ""}`);
        return 0;
      }
      case "adopt": {
        if (!rest[0]) break;
        const me = await adoptRun(rest[0], await scopeOf());
        console.log(`adopted ${rest[0]} (session pid ${me.pid})`);
        return 0;
      }
      case "resume": {
        if (!rest[0]) break;
        const r = await runIn(rest[0], await scopeOf(), undefined, true);
        if (r.alive || r.state.status !== "running") {
          console.log(r.alive ? `${r.id} has its runner` : `${r.id} is ${r.state.status}`);
          return 0;
        }
        await ensureRunner(r.id);
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
