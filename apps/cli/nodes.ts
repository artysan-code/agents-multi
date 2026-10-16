// nodes.ts — `agents nodes`: the machines and the jobs as the service sees them (ADR 0012), and the owner's
// answers. Accepting signs the job here, with the approval key this machine's vault derives: the service only
// carries the signature, and the node checks it before it starts anything. Nothing here runs a job.

import {
  approvalKeys,
  cannotTake,
  type Job,
  type JobSpec,
  type NodeInfo,
  normalRemote,
  place,
} from "../../shared/mcp/lib/nodes.ts";
import { signJob } from "../../shared/mcp/lib/nodes.ts";
import { listRoutines, type Routine } from "../../shared/mcp/lib/routines.ts";
import { loadKey } from "../../shared/mcp/lib/vault.ts";
import { actOn, fleet, getJob, newJob, type Service, service } from "./node/service.ts";
import { inHours } from "./limits.ts";

const DAY_MS = 24 * 3600_000;

/** Pure: how long ago, as a person reads it ("now", "4m", "3h", "2d"). */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const gib = (b: number) => `${(b / 2 ** 30).toFixed(1)}G`;

/** Pure: one line per node: name, online or not, kind, sessions over its cap, memory, accounts, and why it
 *  would take no job now. */
export function nodeLines(nodes: NodeInfo[], now: number): string[] {
  if (!nodes.length) return ["no node has announced itself: agents node enable on a machine"];
  const rows = [...nodes].sort((a, b) => a.name.localeCompare(b.name)).map((n) => {
    const why = cannotTake(n, {}, now);
    return [
      n.name,
      why === "offline" ? `offline (${ago(n.seen, now)})` : "online",
      n.headless ? "server" : n.present ? "desktop, owner at it" : "desktop",
      `${n.running}/${n.cap} sessions`,
      `${gib(n.memFree)} free of ${gib(n.memTotal)}`,
      n.accounts.join(" ") || "no logins",
      why && why !== "offline" ? `takes nothing: ${why}` : "",
    ];
  });
  const width = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i < r.length - 1 ? c.padEnd(width[i]) : c)).join("  ").trimEnd());
}

/** Pure: one line for a job: id, status, where, what, and why. */
export function jobLine(j: Job, now: number): string {
  const where = j.node || "no node yet";
  const what = `${j.kind === "resume" ? "resume " : ""}${j.spec.name}${j.spec.account ? ` (${j.spec.account})` : ""}`;
  const until = j.status === "accepted" && j.expires
    ? `, holds ${inHours(Date.parse(j.expires) / 1000, now / 1000)}`
    : "";
  const why = j.reason ? ` — ${j.reason}` : "";
  return `${j.id}  ${j.status.padEnd(11)} ${where}  ${what}  ${ago(j.updated, now)}${until}${why}`;
}

/** Pure: the jobs worth showing: the open ones (proposed first: they wait for the owner), then the last ended. */
export function jobsToShow(jobs: Job[], ended = 5): Job[] {
  const rank: Record<string, number> = { proposed: 0, accepted: 1, running: 2, interrupted: 3 };
  const open = jobs.filter((j) => j.status in rank).sort((a, b) =>
    rank[a.status] - rank[b.status] || a.created.localeCompare(b.created)
  );
  const done = jobs.filter((j) => !(j.status in rank)).sort((a, b) => b.updated.localeCompare(a.updated));
  return [...open, ...done.slice(0, ended)];
}

/** Pure: the spec of a job that runs a routine elsewhere: its repository by remote, its folder inside it, its
 *  action and account. `top` is the repository's root, `remote` its origin. */
export function routineSpec(r: Routine, top: string, remote: string): JobSpec {
  const path = r.folder === top ? "" : r.folder.startsWith(`${top}/`) ? r.folder.slice(top.length + 1) : "";
  const a = r.action as Routine["action"] & { profile?: string; provider?: string };
  return {
    name: r.name,
    repo: normalRemote(remote),
    path,
    action: r.action as JobSpec["action"],
    ...(a.kind === "agent" && a.profile ? { account: `${a.profile}/${a.provider ?? "claude"}` } : {}),
  };
}

/** Pure: what the owner is about to sign, said in full before the signature is made. */
export function acceptSummary(j: Job, node: string, expires: string): string[] {
  return [
    `job ${j.id}: ${j.kind} ${j.spec.name} on ${node}, until ${expires}`,
    `  repository ${j.spec.repo}${j.spec.path ? ` · ${j.spec.path}` : ""}${
      j.spec.account ? ` · ${j.spec.account}` : ""
    }`,
    `  action ${JSON.stringify(j.spec.action)}`,
    ...(j.reason ? [`  why: ${j.reason}`] : []),
  ];
}

const USAGE = `agents nodes                                   the machines (online, sessions, logins) and the jobs
agents nodes accept <job> [--node N]             sign a proposal here and send it: that node may run it for 24 h
agents nodes decline <job> [reason…]             no: the job is closed
agents nodes propose <routine> [--node N]        run a routine of this machine on another node now (a proposal)
agents nodes propose --run <id> [--node N]       resume a run a node dropped, from its last checkpoint (a proposal)
  --json on list and propose: the answer as JSON (the coordinator's node tools read it); --why <text> says why
agents nodes forget <name>                       forget a machine: its row, what waits on it, its tokens (it must pair again)`;

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args], stdout: "piped", stderr: "null" }).output();
  return r.success ? new TextDecoder().decode(r.stdout).trim() : "";
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function connect(): Promise<Service | null> {
  const s = await service().catch((e: Error) => e.message);
  if (typeof s === "string") {
    console.error(`agents nodes: ${s}`);
    return null;
  }
  return s;
}

export async function nodesCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || (sub && !["accept", "decline", "propose", "list", "forget"].includes(sub))) {
    console.log(USAGE);
    return sub === "--help" || sub === "-h" ? 0 : 2;
  }
  const s = await connect();
  if (!s) return 1;
  const now = Date.now();
  try {
    if (!sub || sub === "list") {
      const f = await fleet(s);
      if (rest.includes("--json")) {
        console.log(JSON.stringify(f));
        return 0;
      }
      const at = Date.parse(f.now) || now;
      console.log(nodeLines(f.nodes, at).join("\n"));
      const jobs = jobsToShow(f.jobs);
      if (jobs.length) console.log(`\njobs\n${jobs.map((j) => jobLine(j, at)).join("\n")}`);
      return 0;
    }
    const asJson = rest.includes("--json");
    if (sub === "propose" && flag(rest, "--run")) {
      // resume a run (ADR 0013, F2): the last job that ran it gives the spec; the owner's yes still decides
      const run = flag(rest, "--run")!;
      const f = await fleet(s);
      const last = f.jobs.filter((j) => j.spec.id === run).sort((a, b) => b.updated.localeCompare(a.updated))[0];
      if (!last) {
        console.error(`agents nodes: no job ran ${run} (agents nodes shows the jobs)`);
        return 1;
      }
      const node = flag(rest, "--node");
      const j = await newJob(s, {
        kind: "resume",
        spec: { ...last.spec, from: last.node },
        ...(node ? { node } : {}),
        reason: flag(rest, "--why") ?? `resume ${run}, proposed from this machine`,
      });
      console.log(asJson ? JSON.stringify({ job: j }) : `${j.id}: proposed${j.node ? ` for ${j.node}` : ""}`);
      return 0;
    }
    const id = rest.find((a) => !a.startsWith("--") && a !== flag(rest, "--node") && a !== flag(rest, "--why"));
    if (!id) {
      console.log(USAGE);
      return 2;
    }
    if (sub === "forget") {
      const r = await s.call<{ node: boolean; turns: number; tokens: number }>(
        "DELETE",
        `/api/nodes/${encodeURIComponent(id)}`,
      );
      console.log(
        `${id}: forgotten (${r.tokens} token${r.tokens === 1 ? "" : "s"} revoked, ${r.turns} turn${
          r.turns === 1 ? "" : "s"
        } released); it comes back only by pairing again`,
      );
      return 0;
    }
    if (sub === "decline") {
      const reason = rest.filter((a) => a !== id).join(" ") || undefined;
      const j = await actOn(s, id, { op: "decline", ...(reason ? { reason } : {}) });
      console.log(`${j.id}: declined`);
      return 0;
    }
    if (sub === "accept") {
      const j = await getJob(s, id);
      if (j.status !== "proposed") {
        console.error(`agents nodes: ${id} is ${j.status}, not a proposal`);
        return 1;
      }
      let node = flag(rest, "--node") ?? j.node;
      if (!node) {
        const f = await fleet(s);
        node = place(j.spec, f.nodes, Date.parse(f.now) || now) ?? "";
      }
      if (!node) {
        console.error("agents nodes: no node can take it now (agents nodes shows why); name one with --node");
        return 1;
      }
      const expires = new Date(now + DAY_MS).toISOString();
      console.log(acceptSummary(j, node, expires).join("\n"));
      const keys = await approvalKeys((await loadKey()).raw);
      const signature = await signJob({ id: j.id, node, kind: j.kind, spec: j.spec, expires }, keys.sign);
      const done = await actOn(s, id, { op: "accept", node, signature, expires });
      console.log(`${done.id}: accepted for ${done.node}, signed here`);
      return 0;
    }
    // propose: a routine of this machine, by id or name
    const r = (await listRoutines()).find((x) => x.id === id || x.name === id);
    if (!r) {
      console.error(`agents nodes: no routine ${id} here (agents routine list --all)`);
      return 1;
    }
    const top = await git(r.folder, "rev-parse", "--show-toplevel");
    const remote = top ? await git(top, "remote", "get-url", "origin") : "";
    if (!remote) {
      console.error(`agents nodes: ${r.folder} has no origin remote: another node could not find the repository`);
      return 1;
    }
    const node = flag(rest, "--node");
    const j = await newJob(s, {
      kind: "routine",
      spec: routineSpec(r, top, remote),
      ...(node ? { node } : {}),
      reason: flag(rest, "--why") ?? "proposed from this machine (agents nodes propose)",
    });
    if (asJson) console.log(JSON.stringify({ job: j }));
    else console.log(`${j.id}: proposed${j.node ? ` for ${j.node}` : ""}; agents nodes accept ${j.id} signs it`);
    return 0;
  } catch (e) {
    const m = (e as Error).message;
    // a brain from before ADR 0012 has no nodes or jobs
    const old = /\/api\/(nodes|jobs)\S*: (not found|HTTP 404)$/.test(m);
    console.error(`agents nodes: ${m}${old ? " — the service runs a version without nodes: update the brain" : ""}`);
    return 1;
  }
}
