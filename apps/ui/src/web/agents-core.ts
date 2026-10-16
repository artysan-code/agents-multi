// agents-core.ts — the Agents view's pure part (ADR 0014, third round, B): the shapes GET /api/runs gives, what each
// event of its stream does to them, and the text a Stop signs. No DOM and no preact: apps/brain/tests/runs_test.ts
// runs it under Deno.

import { canonical } from "../../../../shared/mcp/lib/nodes.ts";

export type RunState = "working" | "waiting" | "idle" | "ended" | "failed";

export interface Run {
  id: string;
  node: string;
  online?: boolean;
  kind: "child" | "routine" | "workflow";
  profile: string;
  provider?: string;
  project: string;
  repo?: string;
  branch?: string;
  title?: string;
  started: string;
  updated: string;
  state: RunState;
  ended?: string;
  tail: string[];
  waiting?: string[];
  routine?: string;
  workflow?: { name: string; step: string; steps: { id: string; state: string }[] };
  job?: string;
  noMove?: string;
}

export interface RoutineInfo {
  node: string;
  name: string;
  schedule: string;
  next?: string;
  last?: string;
  enabled: boolean;
}

export interface StopInfo {
  node: string;
  run: string;
  state: string;
  why: string | null;
  created: string;
}

export interface RunsState {
  runs: Run[];
  routines: RoutineInfo[];
  recent: Run[];
  stops?: StopInfo[];
}

const ENDED: readonly string[] = ["ended", "failed"];
const rank = (s: string) => s === "waiting" ? 0 : s === "working" ? 1 : 2;
const same = (a: Pick<Run, "id" | "node">, b: Pick<Run, "id" | "node">) => a.id === b.id && a.node === b.node;

/** Pure: the live runs in the view's order: waiting first, then working, then the newest. */
export const sortRuns = (runs: Run[]): Run[] =>
  [...runs].sort((a, b) => rank(a.state) - rank(b.state) || b.started.localeCompare(a.started));

/** Pure: the view after one event of the stream: `run` (a run as it is now: live, or ended into the recent ones),
 *  `gone` (dropped from its machine's list), `node` (a machine went offline or came back: its runs are kept, shown
 *  stale). Unknown events change nothing. */
export function applyRunEvent(s: RunsState, name: string, data: Record<string, unknown>): RunsState {
  if (name === "run") {
    const r = data.run as Run | undefined;
    if (!r || typeof r.id !== "string" || typeof r.node !== "string") return s;
    const runs = s.runs.filter((x) => !same(x, r));
    if (ENDED.includes(r.state)) {
      const { online: _o, ...ended } = r;
      return { ...s, runs, recent: [ended, ...s.recent.filter((x) => !same(x, r))].slice(0, 50) };
    }
    return { ...s, runs: sortRuns([...runs, r]) };
  }
  if (name === "gone") {
    const g = { id: String(data.id ?? ""), node: String(data.node ?? "") };
    return { ...s, runs: s.runs.filter((x) => !same(x, g)) };
  }
  if (name === "node" && typeof data.node === "string") {
    const on = data.online === true;
    return { ...s, runs: s.runs.map((x) => x.node === data.node ? { ...x, online: on } : x) };
  }
  return s;
}

/** Pure: the text a stop signs: `agents-multi stop v1\n` and the canonical JSON of `{node, run, expires}` (the node's
 *  apps/cli/node/runs.ts checks the same). */
export const stopText = (s: { node: string; run: string; expires: string }): string =>
  `agents-multi stop v1\n${canonical({ node: s.node, run: s.run, expires: s.expires })}`;

/** The challenge of a stop: SHA-256 of its text. */
export async function stopChallenge(s: { node: string; run: string; expires: string }): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stopText(s))));
}

/** Pure: why the row cannot offer to resume the run elsewhere, or null when it can (the service checks again). */
export function cannotResume(r: Run): string | null {
  if (r.noMove) return r.noMove;
  if (!r.job) return "nojob";
  if (r.online !== false && (r.state === "working" || r.state === "waiting")) return "running";
  return null;
}

/** Pure: whether the row offers a Stop: a run still going, on a machine that is online (it checks the passkey). */
export const stoppable = (r: Run): boolean => !ENDED.includes(r.state) && r.online !== false;

/** Pure: the tone of a state, for its badge. */
export const toneOf = (s: RunState): "info" | "warn" | "ok" | "crit" | "plain" =>
  s === "waiting" ? "warn" : s === "working" ? "info" : s === "failed" ? "crit" : s === "ended" ? "ok" : "plain";

/** Pure: the last stop asked for a run, as the service tells how it ended. */
export const lastStop = (stops: StopInfo[] | undefined, r: Pick<Run, "id" | "node">): StopInfo | undefined =>
  stops?.find((x) => x.node === r.node && x.run === r.id);
