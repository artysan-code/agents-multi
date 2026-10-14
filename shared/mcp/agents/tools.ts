// tools.ts — the coordinator's tools on the hub's children (shared/mcp/lib/agents.ts).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import {
  adoptChild,
  answer,
  type Child,
  childIn,
  listChildren,
  ownerOf,
  sayTo,
  scopeOf,
  startChild,
  stopChild,
  type Verdict,
} from "../lib/agents.ts";
import {
  adoptRun,
  answerRun,
  type Choice,
  listRuns,
  type Plan,
  runEvents,
  runIn,
  savedWorkflows,
  startRun,
} from "../lib/runs.ts";

/** The caller's scope: the coordinator this server runs under (its `claude` process) and the project of
 *  the folder it was started in. By default its own session's, and the project's orphans; `project` and
 *  `all` read more, never write. */
const scopeArgs = {
  project: z.boolean().optional().describe("read-only: also the project's other live sessions' children and runs"),
  all: z.boolean().optional().describe("read-only: every project's"),
};

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
  isError: true,
});

/** A child as the coordinator reads it: who, where, its phase, what it waits for, what it said last. */
const view = (c: Child, full = false) => ({
  id: c.meta.id,
  profile: c.meta.profile,
  provider: c.meta.provider ?? "claude",
  folder: c.meta.dir,
  project: c.meta.project ?? null,
  access: c.access ?? null,
  orphan: c.access === "orphan",
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
      provider: z.enum(["claude", "codex"]).optional().describe(
        "claude (default) or codex: the profile must have a Codex account. A Codex child never asks for a permission: " +
          "its sandbox follows the profile's mode (read-only, or workspace-write where Claude may edit) and a message " +
          "sent during a turn waits for the next one",
      ),
    },
  }, async (i: { profile: string; folder: string; task: string; model?: string; provider?: "claude" | "codex" }) => {
    try {
      const owner = ownerOf(await scopeOf());
      const m = await startChild({
        profile: i.profile,
        dir: i.folder,
        task: i.task,
        model: i.model,
        provider: i.provider,
        owner,
      });
      return text({ started: m.id, profile: m.profile, folder: m.dir });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool(
    "agent_list",
    {
      description: "The children this session started, and the orphans of its project (their session is gone: " +
        "`orphan: true`, adopt one with agent_adopt to act on it). `project` also lists the project's other " +
        "sessions' children, `all` every project's: read-only. Its phase (working, waiting on a request, idle " +
        "after a turn, ended), what it waits for, the last thing it said.",
      inputSchema: scopeArgs,
    },
    async (i: { all?: boolean; project?: boolean }) =>
      text((await listChildren(undefined, await scopeOf(i))).map((c) => view(c))),
  );

  server.registerTool("agent_status", {
    description:
      "One child in full: its task, the last things it said, its pending requests with their ids, how its last turn ended.",
    inputSchema: { id: z.string(), ...scopeArgs },
  }, async ({ id, ...scope }: { id: string; all?: boolean; project?: boolean }) => {
    try {
      return text(view(await childIn(id, await scopeOf(scope)), true));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("agent_adopt", {
    description: "Take an orphan: a child of this project whose coordinator (the session that started it) is " +
      "gone. It becomes this session's, so you can answer, say to and stop it. Never another project's, never " +
      "one whose session is alive.",
    inputSchema: { id: z.string() },
  }, async ({ id }: { id: string }) => {
    try {
      await adoptChild(id, await scopeOf());
      return text({ adopted: id });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("agent_say", {
    description:
      "Write to a child: it reads it between two of its steps, or as a new turn when idle. For the owner's " +
      "answers to its questions, corrections, a next task.",
    inputSchema: { id: z.string(), text: z.string() },
  }, async ({ id, text: t }: { id: string; text: string }) => {
    try {
      await sayTo(id, t, undefined, await scopeOf());
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
      await answer(i.id, i.request, i.answer, i.reason, undefined, i.answers, await scopeOf());
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
      await stopChild(id, !!force, undefined, await scopeOf());
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
      const id = await startRun(plan, undefined, undefined, ownerOf(await scopeOf()));
      return text({ started: id, steps: plan.steps.map((s) => s.id) });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("workflow_list", {
    description: "The saved workflows a folder can use (the project's, then the owner's: read the SKILL.md to " +
      "fill a plan) and the runs this session started, with their steps' state, and the project's orphan runs " +
      "(adopt one with workflow_adopt to act on it). `project`, `all`: other sessions' and projects', read-only.",
    inputSchema: { folder: z.string().optional(), ...scopeArgs },
  }, async ({ folder, ...scope }: { folder?: string; all?: boolean; project?: boolean }) =>
    text({
      saved: await savedWorkflows(folder),
      runs: (await listRuns(undefined, await scopeOf(scope))).map((r) => ({
        id: r.id,
        name: r.plan.name,
        status: r.state.status,
        access: r.access ?? null,
        orphan: r.access === "orphan",
        runner: r.alive,
        steps: Object.fromEntries(Object.entries(r.state.steps).map(([k, v]) => [k, v.status])),
      })),
    }));

  server.registerTool("workflow_status", {
    description: "One run in full: its plan, each step's state, child and HANDOFF, and what happened.",
    inputSchema: { id: z.string(), ...scopeArgs },
  }, async ({ id, ...scope }: { id: string; all?: boolean; project?: boolean }) => {
    try {
      const r = await runIn(id, await scopeOf(scope));
      return text({ ...r, events: (await runEvents(id)).slice(-30) });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("workflow_adopt", {
    description: "Take an orphan run of this project (its coordinator is gone), and its children with it: it " +
      "becomes this session's, so you can answer it. Never another project's, never one whose session is alive.",
    inputSchema: { id: z.string() },
  }, async ({ id }: { id: string }) => {
    try {
      await adoptRun(id, await scopeOf());
      return text({ adopted: id });
    } catch (e) {
      return fail(e);
    }
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
      await answerRun(id, choice, step, undefined, await scopeOf());
      return text({ run: id, step: step ?? null, choice });
    } catch (e) {
      return fail(e);
    }
  });
}
