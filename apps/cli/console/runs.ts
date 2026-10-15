// runs.ts — what the Runs page shows of the agents hub (shared/mcp/lib/agents.ts and runs.ts, ADR 0005):
// the workflow runs with their steps, and the agents the hub started lately, everyone's, read only.
// Acting on them stays with their coordinator, the hub's tools and `agents run`.

import { type Child, listChildren } from "../../../shared/mcp/lib/agents.ts";
import { listRuns, type Run } from "../../../shared/mcp/lib/runs.ts";

export interface StepRow {
  id: string;
  profile: string;
  status: string;
  error?: string;
}

export interface RunRow {
  id: string;
  name: string;
  status: string;
  /** whether its runner is up: a running run without one is stuck until resumed */
  alive: boolean;
  project?: string;
  started: string | null;
  steps: StepRow[];
}

export interface AgentRow {
  id: string;
  profile: string;
  provider: string;
  project?: string;
  dir: string;
  /** the first line of what it was asked */
  task: string;
  started: string;
  phase: string;
  turns: number;
  /** the questions it waits on its coordinator for */
  pending: number;
  /** the last thing it said */
  said: string | null;
  error: string | null;
  run?: { id: string; step: string };
}

const line = (s: string, n: number) => {
  const l = s.trim().split("\n")[0].replace(/\s+/g, " ");
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

/** Pure: a run as a row, its steps in the plan's order. */
export function runRow(r: Run): RunRow {
  const starts = Object.values(r.state.steps).map((s) => s.started).filter((s): s is string => !!s).sort();
  return {
    id: r.id,
    name: r.plan.name,
    status: r.state.status,
    alive: r.alive,
    ...(r.project ? { project: r.project } : {}),
    started: starts[0] ?? null,
    steps: r.plan.steps.map((p) => {
      const s = r.state.steps[p.id];
      return { id: p.id, profile: p.profile, status: s?.status ?? "waiting", ...(s?.error ? { error: s.error } : {}) };
    }),
  };
}

/** Pure: a child of the hub as a row. */
export function agentRow(c: Child): AgentRow {
  const m = c.meta, s = c.state;
  return {
    id: m.id,
    profile: m.profile,
    provider: m.provider ?? "claude",
    ...(m.project ? { project: m.project } : {}),
    dir: m.dir,
    task: line(m.task ?? "", 140),
    started: m.started,
    phase: s.phase,
    turns: s.turns,
    pending: s.pending.length,
    said: s.said.length ? line(s.said[s.said.length - 1], 200) : null,
    error: s.error,
    ...(m.run ? { run: m.run } : {}),
  };
}

const WEEK_MS = 7 * 86400_000;

/** Pure: the agents worth a look: every one still up, and those ended in the last week; newest first. */
export function recentAgents(rows: AgentRow[], now: number, keep = 40): AgentRow[] {
  return rows
    .filter((a) => a.phase !== "ended" || now - Date.parse(a.started) < WEEK_MS)
    .sort((a, b) => Number(b.phase !== "ended") - Number(a.phase !== "ended") || b.started.localeCompare(a.started))
    .slice(0, keep);
}

/** Pure: the runs, the running ones first, then the newest. */
export function sortRuns(rows: RunRow[]): RunRow[] {
  return [...rows].sort((a, b) =>
    Number(b.status === "running") - Number(a.status === "running") ||
    String(b.started ?? "").localeCompare(String(a.started ?? ""))
  );
}

/** GET /api/runs. */
export async function runsView(now = Date.now()) {
  const [runs, children] = await Promise.all([listRuns(), listChildren()]);
  return { runs: sortRuns(runs.map(runRow)), agents: recentAgents(children.map(agentRow), now) };
}
