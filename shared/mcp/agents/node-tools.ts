// node-tools.ts — the coordinator's tools on the owner's nodes (ADR 0013, F2): which machines there are and what
// each can take, and a proposal to run a routine or resume a run on one. They go through the CLI (`agents nodes …
// --json`), which talks to the service with this machine's token: this server holds no credential and reaches no
// network. Read and propose only: a proposal waits for the owner's yes (a desktop's signature or the phone's
// passkey), and nothing here accepts, declines or stops a job.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { z } from "npm:zod@4.6.5";
import { cannotTake, isOnline, type Job, type NodeInfo } from "../lib/nodes.ts";
import { loadNodeConfig } from "../lib/headless.ts";

const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
  isError: true,
});

/** The CLI, as `agents install` links it (servers.json lets this server run that one program). */
const cli = () => `${Deno.env.get("HOME") ?? ""}/.local/bin/agents`;

export type RunCli = (args: string[]) => Promise<{ code: number; out: string; err: string }>;

const realCli: RunCli = async (args) => {
  const r = await new Deno.Command(cli(), { args, stdin: "null", stdout: "piped", stderr: "piped" }).output();
  return { code: r.code, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
};

async function call<T>(run: RunCli, args: string[]): Promise<T> {
  const r = await run(args);
  // the CLI's own line: it carries the service's reason, never a credential
  if (r.code !== 0) {
    throw new Error(r.err.trim().split("\n").at(-1)?.replace(/^agents nodes: /, "") || `exit ${r.code}`);
  }
  return JSON.parse(r.out) as T;
}

/** Pure: the nodes as the coordinator sees them; `repos` are the ones nodes.json lists for servers to clone. */
export function nodeList(nodes: NodeInfo[], now: number, serverRepos: string[]) {
  return nodes.map((n) => ({
    name: n.name,
    online: isOnline(n, now),
    headless: n.headless,
    ...(n.kind ? { kind: n.kind } : {}),
    seen: n.seen,
    sessions: { running: n.running, cap: n.cap },
    accounts: n.accounts,
    sandbox: n.sandbox,
    repos: n.headless ? serverRepos : null,
    takes: cannotTake(n, {}, now) ?? "work",
  }));
}

/** Pure: the arguments of the CLI's proposal. */
export function proposeArgs(p: { routine?: string; run?: string; node?: string; why: string }): string[] {
  if (!p.routine === !p.run) throw new Error("name a routine or a run, one of them");
  return [
    "nodes",
    "propose",
    ...(p.run ? ["--run", p.run] : [p.routine!]),
    ...(p.node ? ["--node", p.node] : []),
    "--why",
    p.why,
    "--json",
  ];
}

export function registerNodeTools(server: McpServer, run: RunCli = realCli) {
  server.registerTool("node_list", {
    description: "The owner's machines as the service sees them: each node's name, whether it is online, a server " +
      "(headless) or a desktop, when it was last seen, its sessions against its cap, the accounts it can run, " +
      "whether its sandbox works, the repositories a server clones, and `takes`: `work`, or why it would take no " +
      "job now. Read it before proposing work on a node.",
    inputSchema: {},
  }, async () => {
    try {
      const f = await call<{ nodes: NodeInfo[]; jobs: Job[]; now: string }>(run, ["nodes", "list", "--json"]);
      const cfg = await loadNodeConfig().catch(() => ({ repos: [] as string[] }));
      return text({ nodes: nodeList(f.nodes, Date.parse(f.now) || Date.now(), cfg.repos) });
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("node_propose", {
    description: "Propose work on a node: run a routine of this machine elsewhere now (`routine`: its id or name), " +
      "or resume a run a node dropped (`run`: its id), with `why`. Without `node` the best one is chosen when the owner " +
      "says yes (online, sandbox working, room, the account; a server when the owner is away). It only PROPOSES: the job waits for " +
      "the owner's yes (their desktop's signature or their phone's passkey) and nothing starts until then. Tell the " +
      "owner it waits for them; never answer for them.",
    inputSchema: {
      routine: z.string().optional().describe("a routine of this machine, by id or name"),
      run: z.string().optional().describe("a run to resume, by id"),
      node: z.string().optional().describe("where; absent, the best node"),
      why: z.string().min(3).max(300).describe("why, in a sentence the owner reads before saying yes"),
    },
  }, async (p: { routine?: string; run?: string; node?: string; why: string }) => {
    try {
      const { job } = await call<{ job: Job }>(run, proposeArgs(p));
      return text({
        job: { id: job.id, kind: job.kind, name: job.spec.name, node: job.node || null, status: job.status },
        // without a node, the yes places it (nodes.ts `place`, with the job's account)
        waits: "for the owner's yes: their desktop signs it (agents nodes accept) or their phone's passkey does" +
          (job.node ? "" : "; the best node is chosen then"),
      });
    } catch (e) {
      return fail(e);
    }
  });
}
