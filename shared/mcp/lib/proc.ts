// proc.ts — who the coordinator is: the `claude` process a caller runs under. The hub's children and runs
// belong to a coordinator, and a coordinator is a process, not an environment variable: a variable such as
// CLAUDE_CODE_SESSION_ID is inherited by whatever a session starts, so it names the wrong session as soon
// as one session runs inside another. A process cannot be inherited: the MCP server is a stdio child of
// the coordinator's `claude`, and the CLI run from its Bash tool has it as an ancestor; both walk up to the
// nearest one. Its pid plus its start time (a pid alone is reused) is the identity; it stays true for as
// long as that process lives, and when it is gone whatever it owned is an orphan.
//
// Read from the platform layer's process list (`ps`, not /proc: Deno lets only --allow-all read /proc, and the MCP
// server has `ps` only). One listing, kept for a second: a look at a dozen children asks it once. Every other
// file asks through `ProcReader`.

import { listProcesses, parsePs, type ProcInfo } from "./platform.ts";

/** A process as the hub names a coordinator: pid and start time (seconds since the epoch, as a string). */
export interface Proc {
  pid: number;
  start: string;
}

/** What the platform layer says of one process. */
export type { ProcInfo };

/** Reads a process; null when it is not there (or is a zombie: gone for what it owned). */
export type ProcReader = (pid: number) => ProcInfo | null;

/** `ps` prints a start time to the second, derived from the boot time, which a clock step can move by a
 *  second or two: two starts this close are the same process (a reused pid is minutes away at least). */
const SAME_START_S = 3;

export { parsePs };

let cached: { at: number; table: Map<number, ProcInfo> } | undefined;

/** Forgets the table kept: the next read asks `ps` again. */
export const forgetProcs = () => {
  cached = undefined;
};

function table(): Map<number, ProcInfo> {
  if (cached && Date.now() - cached.at < 1000) return cached.table;
  cached = { at: Date.now(), table: listProcesses() };
  return cached.table;
}

export const procReader: ProcReader = (pid) => table().get(pid) ?? null;

/** Pure: whether a process name is a Claude's (`claude`, `claude-bin`, the Desktop's `claude-desktop-…`). */
export const isClaude = (comm: string): boolean => /^claude/i.test(comm);

/** The coordinator `from` runs under: the nearest `claude` process among its ancestors (itself first).
 *  null when none is: a plain terminal, where the person is the coordinator. */
export function coordinatorFrom(from: number, read: ProcReader = procReader): Proc | null {
  const seen = new Set<number>();
  for (let pid = from; pid > 1 && !seen.has(pid);) {
    seen.add(pid);
    const p = read(pid);
    if (!p) return null;
    if (isClaude(p.comm)) return { pid, start: p.start };
    pid = p.ppid;
  }
  return null;
}

/** The coordinator this very process runs under. */
export const myCoordinator = (read: ProcReader = procReader): Proc | null => coordinatorFrom(Deno.pid, read);

/** Whether two recorded start times are the same moment. */
export const sameStart = (a: string, b: string): boolean => Math.abs(Number(a) - Number(b)) <= SAME_START_S;

/** Whether a coordinator is still the process it was: its pid is there with the same start time. */
export function procAlive(p: Proc | undefined, read: ProcReader = procReader): boolean {
  if (!p || !p.pid || !p.start) return false;
  const now = read(p.pid);
  return !!now && sameStart(now.start, p.start);
}
