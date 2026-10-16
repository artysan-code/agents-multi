// panel.ts — what the agents panel shows (ADR 0014, C): one snapshot of the session's children, runs,
// pending requests and accounts' limits, assembled from what agents.ts, runs.ts and providers.ts read.
// Pure: the reads happen in shared/mcp/agents/panel-tools.ts, with the same scope as agent_list.
import type { Child, Question } from "./agents.ts";
import type { Account } from "./providers.ts";
import type { Run } from "./runs.ts";
import type { Window } from "./limits.ts";

export const PANEL_URI = "ui://agents/panel";
export const PANEL_MIME = "text/html;profile=mcp-app";

/** How often the frame asks again: while something works or waits, and when all is idle. */
export const POLL_BUSY_MS = 2_000;
export const POLL_IDLE_MS = 15_000;

export interface PanelChild {
  id: string;
  profile: string;
  provider: string;
  project: string | null;
  phase: string;
  orphan?: true;
  /** the workflow run and step it is, when it is one */
  run?: { id: string; step: string };
  started: string;
  /** how its last turn ended, in short */
  last: string | null;
  /** the last things it said, newest last */
  tail: string[];
}

export interface PanelRun {
  id: string;
  name: string;
  state: string;
  /** the step to look at: the one waiting for a go, failed, or at work */
  step: string | null;
  steps: { id: string; state: string }[];
  /** a step waiting for the owner's go */
  confirm?: string;
  /** a step that failed: retry, skip or stop */
  failed?: string;
  /** its runner is gone while the run is not over: retry starts it again */
  stalled?: true;
  orphan?: true;
}

export interface PanelRequest {
  /** the request's id, for agent_answer */
  id: string;
  child: string;
  profile: string;
  kind: "request" | "question";
  /** exactly what the child wants to do, shown as text */
  what: string;
  description?: string;
  questions?: Question[];
  /** what "yes for the session" would allow */
  session: string;
  /** its child's coordinator is gone: it must be adopted before an answer */
  orphan?: true;
}

export interface PanelLimit {
  profile: string;
  provider: string;
  windows: { name: string; used: number; resets: number | null }[];
}

export interface Snapshot {
  at: string;
  children: PanelChild[];
  runs: PanelRun[];
  requests: PanelRequest[];
  limits: PanelLimit[];
  /** in how many milliseconds the frame should ask again */
  poll: number;
  /** a part could not be read: what is shown of it may be old or missing */
  stale?: string[];
}

const cut = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s;

/** Pure: a child as the panel shows it. */
export function panelChild(c: Child): PanelChild {
  return {
    id: c.meta.id,
    profile: c.meta.profile,
    provider: c.meta.provider ?? "claude",
    project: c.meta.project ?? null,
    phase: c.state.phase,
    ...(c.access === "orphan" ? { orphan: true as const } : {}),
    ...(c.meta.run ? { run: c.meta.run } : {}),
    started: c.meta.started,
    last: c.state.error ?? (c.state.lastResult ? cut(c.state.lastResult, 400) : null),
    tail: c.state.said.slice(-3).map((s) => cut(s, 400)),
  };
}

/** Pure: a child's pending requests and questions, each with what it needs to be answered. */
export function panelRequests(c: Child): PanelRequest[] {
  return c.state.pending.map((p) => ({
    id: p.request,
    child: c.meta.id,
    profile: c.meta.profile,
    kind: p.kind,
    what: p.what,
    ...(p.description ? { description: p.description } : {}),
    ...(p.kind === "question" && p.questions ? { questions: p.questions } : {}),
    session: p.session,
    ...(c.access === "orphan" ? { orphan: true as const } : {}),
  }));
}

/** Pure: a run as the panel shows it, with the step that needs the owner first. */
export function panelRun(r: Run): PanelRun {
  const steps = (r.plan.steps ?? []).map((s) => ({ id: s.id, state: r.state.steps[s.id]?.status ?? "waiting" }));
  const find = (state: string) => steps.find((s) => s.state === state)?.id;
  const confirm = find("confirm");
  const failed = find("failed");
  const over = r.state.status !== "running";
  return {
    id: r.id,
    name: r.plan.name,
    state: r.state.status,
    step: confirm ?? failed ?? find("running") ?? null,
    steps,
    ...(confirm ? { confirm } : {}),
    ...(failed ? { failed } : {}),
    ...(!over && !r.alive ? { stalled: true as const } : {}),
    ...(r.access === "orphan" ? { orphan: true as const } : {}),
  };
}

/** Pure: an account's windows as the panel shows them. */
export const panelLimit = (a: { account: Account; windows: Window[] }): PanelLimit => ({
  profile: a.account.profile,
  provider: a.account.provider,
  windows: a.windows.map((w) => ({ name: w.window, used: Math.round(w.usedPercent), resets: w.resetsAt })),
});

/** Pure: whether something is at work or waits for the owner (the frame then asks every 2 s). */
export const busy = (s: Pick<Snapshot, "children" | "runs" | "requests">): boolean =>
  s.requests.length > 0 || s.children.some((c) => c.phase === "working" || c.phase === "waiting") ||
  s.runs.some((r) => r.state === "running");

/** Pure: the snapshot of what a scope sees. `stale` names the parts that could not be read. */
export function snapshotOf(
  x: { children: Child[]; runs: Run[]; limits: { account: Account; windows: Window[] }[]; stale?: string[] },
  now = new Date(),
): Snapshot {
  const base = {
    children: x.children.map(panelChild),
    runs: x.runs.map(panelRun),
    requests: x.children.flatMap(panelRequests),
  };
  return {
    at: now.toISOString(),
    ...base,
    limits: x.limits.map(panelLimit),
    poll: busy(base) ? POLL_BUSY_MS : POLL_IDLE_MS,
    ...(x.stale?.length ? { stale: x.stale } : {}),
  };
}

/** Pure: the panel in a few lines, for the model and for a host that does not show the frame. */
export function summaryOf(s: Snapshot): string {
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const working = s.children.filter((c) => c.phase === "working").length;
  const running = s.runs.filter((r) => r.state === "running").length;
  const lines = [
    `${count(s.children.length, "child", "children")} (${working} working), ` +
    `${count(s.runs.length, "run", "runs")} (${running} running), ` +
    `${count(s.requests.length, "request", "requests")} waiting.`,
  ];
  for (const r of s.requests) {
    lines.push(`- ${r.child} (${r.profile}) ${r.kind === "question" ? "asks" : "wants"}: ${cut(r.what, 200)}`);
  }
  for (const r of s.runs) {
    if (r.confirm) lines.push(`- run ${r.id}: step ${r.confirm} waits for a go`);
    if (r.failed) lines.push(`- run ${r.id}: step ${r.failed} failed`);
    if (r.stalled) lines.push(`- run ${r.id}: its runner is gone`);
  }
  if (s.stale?.length) lines.push(`(not read: ${s.stale.join(", ")})`);
  return lines.join("\n");
}
