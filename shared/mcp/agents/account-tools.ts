// account-tools.ts — the coordinator's tools on the limits manager (shared/mcp/lib/limitrules.ts, ADR 0010):
// where the accounts stand against the owner's rules, the project's default account, and the proposals to use
// another one. A coordinator PROPOSES; the owner accepts; the console applies. Nothing here changes an account.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import { folderless, reaches, scopeOf } from "../lib/agents.ts";
import {
  accountId,
  decide,
  listProposals,
  loadRules,
  projectAccount,
  propose,
  readEvents,
  readSnapshot,
} from "../lib/limitrules.ts";
import { listAccounts } from "../lib/providers.ts";
import { readRoutine } from "../lib/routines.ts";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
  isError: true,
});

export function registerAccountTools(server: McpServer) {
  server.registerTool("account_status", {
    description: "Where the accounts stand against the owner's limit rules: each account's status (`ok`, or " +
      "`blocked` at the stop threshold: it takes no new unattended work), its highest use and windows as of the " +
      "last scan (`scanned_at`; none or old means unknown, never empty), the rules, THIS project's default " +
      "account, the proposals waiting for the owner, and the latest limit events (`blocked`, `expiring` — a " +
      "window about to reset with room left, `reset`). Read it before choosing an account for work; a held " +
      "routine raises a proposal on its own.",
    inputSchema: {},
  }, async () => {
    try {
      const scope = await scopeOf();
      const snap = await readSnapshot();
      return text({
        scanned_at: snap ? new Date(snap.at * 1000).toISOString() : null,
        accounts: (await listAccounts()).map((a) => ({
          account: a.id,
          status: snap?.accounts[a.id]?.status ?? "unknown",
          used_percent: snap?.accounts[a.id]?.used ?? null,
          blocked_by: snap?.accounts[a.id]?.by ?? null,
          windows: snap?.accounts[a.id]?.windows ?? [],
        })),
        rules: await loadRules(),
        project: scope.project,
        project_default: folderless(scope) ? null : await projectAccount(scope.project),
        proposals: (await listProposals()).filter((p) => reaches(p.project, scope) && p.status === "pending"),
        events: await readEvents(undefined, 10),
      });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("account_propose", {
    description: "Propose that work use another account: for one routine (`routine`) or as this project's default " +
      "(`project`). It changes nothing: it waits for the owner, who accepts or declines it — put it to them with " +
      "AskUserQuestion, then carry the answer with account_accept / account_decline. Never switch an organisation's " +
      "account for a project without that answer.",
    inputSchema: {
      scope: z.enum(["routine", "project"]),
      routine: z.string().optional().describe("the routine's id, with scope `routine`"),
      to: z.string().describe("the account to use instead: profile/provider, as account_status lists it"),
      reason: z.string().describe("why, in a line: limits, organisation"),
    },
  }, async (i: { scope: "routine" | "project"; routine?: string; to: string; reason: string }) => {
    try {
      const me = await scopeOf();
      let from = "none";
      let project = me.project;
      if (i.scope === "routine") {
        const r = i.routine ? await readRoutine(i.routine) : null;
        if (!r || !reaches(r.project, me)) throw new Error(`no routine ${i.routine} in this project`);
        if (r.action.kind !== "agent") throw new Error("a plan's accounts are its steps': change the plan");
        from = accountId({ profile: r.action.profile, provider: r.action.provider ?? "claude" });
        project = r.project;
      } else {
        if (folderless(me)) throw new Error("a project's default is proposed from a session in that project");
        const d = await projectAccount(me.project);
        if (d) from = accountId(d);
      }
      const p = await propose(
        {
          scope: i.scope,
          project,
          routine: i.routine,
          from,
          to: i.to,
          reason: i.reason,
          by: "coordinator",
        },
        (await listAccounts()).map((a) => a.id),
      );
      return text({ proposal: p.id, from, to: p.to, status: p.status });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("account_proposals", {
    description: "The proposals of this project: pending ones wait for the owner (raised by a held routine or by a " +
      "coordinator); accepted ones are applied by the console within a minute.",
    inputSchema: {},
  }, async () => {
    const scope = await scopeOf();
    return text((await listProposals()).filter((p) => reaches(p.project, scope)));
  });

  const answer = async (id: string, accept: boolean) => {
    try {
      const me = await scopeOf();
      const p = (await listProposals()).find((x) => x.id === id);
      if (!p || !reaches(p.project, me)) throw new Error(`no proposal ${id} in this project`);
      return text(await decide(id, accept));
    } catch (e) {
      return fail(e);
    }
  };

  server.registerTool("account_accept", {
    description: "Carry the owner's YES to a proposal — only after they said it. The console then applies it (a " +
      "routine's account, or the project's default) within a minute.",
    inputSchema: { id: z.string() },
  }, ({ id }: { id: string }) => answer(id, true));

  server.registerTool("account_decline", {
    description: "Carry the owner's NO to a proposal: it is closed and nothing changes.",
    inputSchema: { id: z.string() },
  }, ({ id }: { id: string }) => answer(id, false));
}
