// routine-tools.ts — the coordinator's tools on the routines (shared/mcp/lib/routines.ts, ADR 0010): schedule
// an unattended job from chat. They write and read the routines' files; the console fires them.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import { scopeOf } from "../lib/agents.ts";
import { parseAt } from "../lib/cron.ts";
import { addRoutine, listRoutines, readRoutine, readState, removeRoutine, requestFire } from "../lib/routines.ts";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
  isError: true,
});

export function registerRoutineTools(server: McpServer) {
  server.registerTool("routine_add", {
    description: "Schedule an unattended job: a child (`profile`, `task`) or a saved plan (`workflow`: a plan.json) " +
      "in `folder` (a git repository under home), at a time. Triggers: `at` (one-shot: `02:00` is the next 02:00, " +
      "`2026-10-15T02:00`, `+90m`), `cron` (five fields, local time), `on` (`run-done` / `run-failed`, a workflow " +
      "run of the project ending). It runs in a worktree on its own branch under the repository's run policy: " +
      "commits yes; push only to that branch and the development branch, never main or release; outward actions " +
      "wait for the owner. Ask the owner before you schedule.",
    inputSchema: {
      name: z.string().optional(),
      at: z.string().optional(),
      cron: z.string().optional(),
      on: z.enum(["run-done", "run-failed"]).optional(),
      plan_name: z.string().optional().describe("with `on`: only runs of the plan with this name"),
      folder: z.string().describe("the repository's folder, e.g. ~/work/acme/site"),
      profile: z.string().optional().describe("the profile whose account runs the child"),
      model: z.string().optional(),
      workflow: z.string().optional().describe("a plan.json (path, relative to the folder): {{task}} in its prompts"),
      task: z.string().optional().describe("what the child has to do, complete"),
      grace_minutes: z.number().optional().describe("how late it may start before it counts as missed"),
    },
  }, async (i: {
    name?: string;
    at?: string;
    cron?: string;
    on?: "run-done" | "run-failed";
    plan_name?: string;
    folder: string;
    profile?: string;
    model?: string;
    workflow?: string;
    task?: string;
    grace_minutes?: number;
  }) => {
    try {
      if ([i.at, i.cron, i.on].filter((x) => x !== undefined).length !== 1) {
        throw new Error("exactly one of at, cron, on");
      }
      if (!i.workflow && !i.profile) throw new Error("a profile (for a child) or a workflow (a plan)");
      const scope = await scopeOf();
      const r = await addRoutine({
        name: i.name,
        folder: i.folder,
        grace: i.grace_minutes,
        trigger: i.cron !== undefined
          ? { kind: "cron", expr: i.cron }
          : i.at !== undefined
          ? { kind: "at", at: parseAt(i.at, new Date()) }
          : { kind: "event", on: i.on!, ...(i.plan_name ? { plan: i.plan_name } : {}) },
        action: i.workflow
          ? { kind: "workflow", plan: i.workflow, task: i.task }
          : { kind: "agent", profile: i.profile!, task: i.task ?? "", model: i.model },
        by: scope.me,
      });
      if (r.project !== scope.project && scope.me) {
        await removeRoutine(r.id);
        throw new Error("a session schedules only in its own project");
      }
      return text({ scheduled: r.id, trigger: r.trigger, project: r.project });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("routine_list", {
    description: "The routines of this project: trigger, next time, what they started (runs, branches). `all` " +
      "lists every project's, read-only.",
    inputSchema: { all: z.boolean().optional() },
  }, async ({ all }: { all?: boolean }) => {
    const scope = await scopeOf({ all });
    const out = [];
    for (const r of await listRoutines()) {
      if (scope.view !== "all" && r.project !== scope.project) continue;
      const st = await readState(r.id);
      out.push({ ...r, state: { ...st, seen: undefined } });
    }
    return text(out);
  });

  server.registerTool("routine_rm", {
    description: "Remove a routine of this project. What it already started stays (worktree, branch, children).",
    inputSchema: { id: z.string() },
  }, async ({ id }: { id: string }) => {
    try {
      const r = await readRoutine(id);
      if (!r || r.project !== (await scopeOf()).project) throw new Error(`no routine ${id} in this project`);
      await removeRoutine(id);
      return text({ removed: id });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("routine_run", {
    description: "Fire a routine of this project now (the console starts it within 15 seconds).",
    inputSchema: { id: z.string() },
  }, async ({ id }: { id: string }) => {
    try {
      const r = await readRoutine(id);
      if (!r || r.project !== (await scopeOf()).project) throw new Error(`no routine ${id} in this project`);
      await requestFire(id);
      return text({ requested: id });
    } catch (e) {
      return fail(e);
    }
  });
}
