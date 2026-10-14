// proc.ts — who the coordinator is: the `claude` process a caller runs under. The hub's children and runs
// belong to a coordinator, and a coordinator is a process, not an environment variable: a variable such as
// CLAUDE_CODE_SESSION_ID is inherited by whatever a session starts, so it names the wrong session as soon
// as one session runs inside another. A process cannot be inherited: the MCP server is a stdio child of
// the coordinator's `claude`, and the CLI run from its Bash tool has it as an ancestor; both walk up to the
// nearest one. Its pid plus its start time (a pid alone is reused) is the identity; it stays true for as
// long as that process lives, and when it is gone whatever it owned is an orphan.
//
// Read with `ps`, not /proc: Deno lets only --allow-all read /proc, and the MCP server has `ps` only. One
// `ps` lists every process, kept for a second: a look at a dozen children asks it once. This file is the
// platform layer's to port: every other file asks through `ProcReader`.

/** A process as the hub names a coordinator: pid and start time (seconds since the epoch, as a string). */
export interface Proc {
  pid: number;
  start: string;
}

/** What `ps` says of one process. */
export interface ProcInfo {
  ppid: number;
  comm: string;
  start: string;
}

/** Reads a process; null when it is not there (or is a zombie: gone for what it owned). */
export type ProcReader = (pid: number) => ProcInfo | null;

/** `ps` prints a start time to the second, derived from the boot time, which a clock step can move by a
 *  second or two: two starts this close are the same process (a reused pid is minutes away at least). */
const SAME_START_S = 3;

/** Pure: `ps -A -o pid=,ppid=,stat=,lstart=,comm=` (LC_ALL=C) as a table. A line it cannot read, and a
 *  zombie, are left out. */
export function parsePs(out: string): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (!m || m[3].startsWith("Z")) continue;
    const at = Date.parse(m[4]);
    if (!Number.isFinite(at)) continue;
    table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[5], start: String(Math.round(at / 1000)) });
  }
  return table;
}

let cached: { at: number; table: Map<number, ProcInfo> } | undefined;

/** Forgets the table kept: the next read asks `ps` again. */
export const forgetProcs = () => {
  cached = undefined;
};

function table(): Map<number, ProcInfo> {
  if (cached && Date.now() - cached.at < 1000) return cached.table;
  const r = new Deno.Command("ps", {
    args: ["-A", "-o", "pid=,ppid=,stat=,lstart=,comm="],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "null",
  }).outputSync();
  if (!r.success) throw new Error("`ps` failed: the hub cannot tell which coordinators are alive");
  cached = { at: Date.now(), table: parsePs(new TextDecoder().decode(r.stdout)) };
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
