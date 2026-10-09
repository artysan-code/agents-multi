// tools.ts — the coordinator's tools on the hub's children (shared/mcp/lib/agents.ts).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import {
  answer,
  type Child,
  listChildren,
  readChild,
  sayTo,
  startChild,
  stopChild,
  type Verdict,
} from "../lib/agents.ts";
import {
  answerRun,
  type Choice,
  listRuns,
  type Plan,
  readRun,
  runEvents,
  savedWorkflows,
  startRun,
} from "../lib/runs.ts";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
  isError: true,
});

/** A child as the coordinator reads it: who, where, its phase, what it waits for, what it said last. */
const view = (c: Child, full = false) => ({
  id: c.meta.id,
  profile: c.meta.profile,
  folder: c.meta.dir,
  task: full ? c.meta.task : c.meta.task.slice(0, 200),
  started: c.meta.started,
  phase: c.state.phase,
  mode: c.meta.mode ?? "default",
  waiting_for: c.state.pending.map((p) => ({
    request: p.request,
    kind: p.kind,
    what: p.what,
    description: p.description,
    ...(p.kind === "question" ? { questions: p.questions } : { session: p.session }),
  })),
  said: full ? c.state.said : c.state.said.slice(-1).map((s) => s.slice(0, 400)),
  turns: c.state.turns,
  last_result: c.state.lastResult?.slice(0, full ? 4000 : 400) ?? null,
  error: c.state.error,
  cost_usd: c.state.costUsd,
});

export function registerAgentTools(server: McpServer) {
  server.registerTool("agent_start", {
    description: "Start a child: a Claude Code session of `profile`, in `folder` (under the home folder, ~ allowed), " +
      "given `task` as its first message. It runs on its own; every permission its profile does not grant comes back " +
      "as a request for the owner. Say in a line what you started.",
    inputSchema: {
      profile: z.string().describe("the profile whose account and rules it runs with"),
      folder: z.string().describe("the project's folder, e.g. ~/work/acme/site"),
      task: z.string().describe("what it has to do, complete: it knows only this and the folder"),
      model: z.string().optional(),
    },
  }, async (i: { profile: string; folder: string; task: string; model?: string }) => {
    try {
      const m = await startChild({ profile: i.profile, dir: i.folder, task: i.task, model: i.model });
      return text({ started: m.id, profile: m.profile, folder: m.dir });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("agent_list", {
    description: "Every child on this machine: its phase (working, waiting on a request, idle after a turn, ended), " +
      "what it waits for, the last thing it said.",
    inputSchema: {},
  }, async () => text((await listChildren()).map((c) => view(c))));

  server.registerTool("agent_status", {
    description:
      "One child in full: its task, the last things it said, its pending requests with their ids, how its last turn ended.",
    inputSchema: { id: z.string() },
  }, async ({ id }: { id: string }) => {
    const c = await readChild(id);
    return c ? text(view(c, true)) : fail(new Error(`no child ${id}`));
  });

  server.registerTool("agent_say", {
    description:
      "Write to a child: it reads it between two of its steps, or as a new turn when idle. For the owner's " +
      "answers to its questions, corrections, a next task.",
    inputSchema: { id: z.string(), text: z.string() },
  }, async ({ id, text: t }: { id: string; text: string }) => {
    try {
      await sayTo(id, t);
      return text({ sent: id });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("agent_answer", {
    description: "Answer one of a child's permission requests or questions — only with what the owner decided. " +
      "A request: `allow` lets it do exactly what it asked; `session` also allows the request's `session` rule " +
      "until the child ends; `deny` carries `reason`, which the child reads. A question: `allow` with `answers`, " +
      'each of its questions to the label the owner chose (several joined by ", "); `deny` leaves it unanswered.',
    inputSchema: {
      id: z.string(),
      request: z.string().describe("the request's id, from the event or agent_status"),
      answer: z.enum(["allow", "session", "deny"]),
      answers: z.record(z.string(), z.string()).optional().describe("a question's answers: question text → label"),
      reason: z.string().optional(),
    },
  }, async (i: { id: string; request: string; answer: Verdict; answers?: Record<string, string>; reason?: string }) => {
    try {
      await answer(i.id, i.request, i.answer, i.reason, undefined, i.answers);
      return text({ answered: i.request, answer: i.answer });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("agent_stop", {
    description: "End a child: after its current turn, or at once with `force` (what it was doing is cut).",
    inputSchema: { id: z.string(), force: z.boolean().optional() },
  }, async ({ id, force }: { id: string; force?: boolean }) => {
    try {
      await stopChild(id, !!force);
      return text({ stopping: id });
    } catch (e) {
      return fail(e);
    }
  });

  const step = z.object({
    id: z.string().describe("lowercase, e.g. review"),
    profile: z.string().describe("the profile (so the account) it runs with"),
    folder: z.string().optional().describe("its folder; the plan's when absent"),
    model: z.string().optional(),
    prompt: z.string().describe("what it has to do, complete: it knows only this, its folder and the HANDOFFs"),
    after: z.array(z.string()).optional().describe("the steps it waits for"),
    confirm: z.boolean().optional().describe("wait for the owner's go before it starts (publishing, deploying…)"),
  });

  server.registerTool("workflow_start", {
    description: "Start a workflow run from a plan the owner has approved — never one they have not seen. The hub " +
      "runs it on its own: steps start when the ones they wait for are done, each writes a HANDOFF the next " +
      "reads, they can talk on the run's team channel. Follow it with `agents agent events --follow`.",
    inputSchema: {
      name: z.string(),
      folder: z.string().optional().describe("the steps' folder when they do not name one"),
      tasks: z.array(z.string()).optional().describe("brain tasks the run belongs to (ids or refs), if any"),
      concurrency: z.number().int().min(1).max(8).optional().describe("steps at work at once, default 3"),
      steps: z.array(step),
    },
  }, async (plan: Plan) => {
    try {
      const id = await startRun(plan);
      return text({ started: id, steps: plan.steps.map((s) => s.id) });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("workflow_list", {
    description: "The saved workflows a folder can use (the project's, then the owner's: read the SKILL.md to " +
      "fill a plan) and the runs on this machine with their steps' state.",
    inputSchema: { folder: z.string().optional() },
  }, async ({ folder }: { folder?: string }) =>
    text({
      saved: await savedWorkflows(folder),
      runs: (await listRuns()).map((r) => ({
        id: r.id,
        name: r.plan.name,
        status: r.state.status,
        runner: r.alive,
        steps: Object.fromEntries(Object.entries(r.state.steps).map(([k, v]) => [k, v.status])),
      })),
    }));

  server.registerTool("workflow_status", {
    description: "One run in full: its plan, each step's state, child and HANDOFF, and what happened.",
    inputSchema: { id: z.string() },
  }, async ({ id }: { id: string }) => {
    const r = await readRun(id);
    return r ? text({ ...r, events: (await runEvents(id)).slice(-30) }) : fail(new Error(`no run ${id}`));
  });

  server.registerTool("workflow_answer", {
    description: "Carry the owner's decision to a run — only what they decided. A step to confirm: `go` or " +
      "`skip`. A step that failed: `retry`, `skip` (the steps after it run without its HANDOFF) or `stop`. " +
      "Without a step: `stop` ends the whole run, `retry` starts its runner again when it stopped.",
    inputSchema: {
      id: z.string(),
      step: z.string().optional(),
      choice: z.enum(["go", "retry", "skip", "stop"]),
    },
  }, async ({ id, step, choice }: { id: string; step?: string; choice: Choice }) => {
    try {
      await answerRun(id, choice, step);
      return text({ run: id, step: step ?? null, choice });
    } catch (e) {
      return fail(e);
    }
  });
}
