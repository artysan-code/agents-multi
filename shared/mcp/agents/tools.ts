// tools.ts — the coordinator's tools on the hub's children (shared/mcp/lib/agents.ts).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import { answer, type Child, listChildren, readChild, sayTo, startChild, stopChild } from "../lib/agents.ts";

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
  waiting_for: c.state.pending.map((p) => ({ request: p.request, what: p.what, description: p.description })),
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
    description: "Answer one of a child's permission requests — only with what the owner decided for that request. " +
      "`allow` lets it do exactly what it asked; a denial carries `reason`, which the child reads.",
    inputSchema: {
      id: z.string(),
      request: z.string().describe("the request's id, from agent_status"),
      allow: z.boolean(),
      reason: z.string().optional(),
    },
  }, async (i: { id: string; request: string; allow: boolean; reason?: string }) => {
    try {
      await answer(i.id, i.request, i.allow, i.reason);
      return text({ answered: i.request, allow: i.allow });
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
}
