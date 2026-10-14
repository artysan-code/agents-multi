// Tests for the coordinator's identity (shared/mcp/lib/proc.ts): the /proc line, the walk up to the nearest
// `claude` process, and whether a recorded coordinator is still the process it was. A fake process table:
// nothing here reads the real one, except one line about this very process.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  coordinatorFrom,
  isClaude,
  myCoordinator,
  parsePs,
  procAlive,
  type ProcInfo,
  procReader,
} from "../../../shared/mcp/lib/proc.ts";

const table = (rows: Record<number, [ppid: number, comm: string, start: string]>) => (pid: number): ProcInfo | null =>
  rows[pid] ? { ppid: rows[pid][0], comm: rows[pid][1], start: rows[pid][2] } : null;

Deno.test("proc: parsePs — pid, ppid, name and start time to the second; zombies and odd lines left out", () => {
  const out = [
    "      1       0 Ss   Wed Oct 14 09:46:25 2026 systemd",
    "3015689    4148 Sl   Wed Oct 14 13:35:24 2026 claude-bin",
    "  77  3015689 S    Thu Oct  1 07:00:01 2026 a name with spaces",
    "  78  3015689 Z    Thu Oct  1 07:00:02 2026 defunct",
    "garbage",
    "",
  ].join("\n");
  const t = parsePs(out);
  assertEquals([...t.keys()], [1, 3015689, 77]);
  assertEquals(t.get(3015689)?.comm, "claude-bin");
  assertEquals(t.get(3015689)?.ppid, 4148);
  assertEquals(t.get(77)?.comm, "a name with spaces");
  assertEquals(
    Number(t.get(3015689)!.start) - Number(t.get(1)!.start),
    (Date.parse("Oct 14 2026 13:35:24") - Date.parse("Oct 14 2026 09:46:25")) / 1000,
  );
});

Deno.test("proc: isClaude — the CLI, its binary, the Desktop; not a shell or deno", () => {
  for (const c of ["claude", "claude-bin", "claude-desktop-"]) assert(isClaude(c), c);
  for (const c of ["zsh", "deno", "bash", "node", "sleep"]) assert(!isClaude(c), c);
});

Deno.test("proc: coordinatorFrom — the nearest claude above, itself first; none in a plain terminal", () => {
  const read = table({
    100: [1, "systemd", "1"],
    200: [100, "claude-bin", "2000"], // a coordinator
    300: [200, "zsh", "3000"], // its Bash tool's shell
    400: [300, "deno", "4000"], // the CLI
    500: [200, "deno", "5000"], // the MCP server: a stdio child
    600: [400, "claude-bin", "6000"], // a child session a coordinator's Bash started: its own coordinator
    700: [600, "deno", "7000"],
    800: [100, "zsh", "8000"], // a terminal
    900: [800, "deno", "9000"],
  });
  assertEquals(coordinatorFrom(400, read), { pid: 200, start: "2000" });
  assertEquals(coordinatorFrom(500, read), { pid: 200, start: "2000" }, "the server and the CLI agree");
  assertEquals(coordinatorFrom(200, read), { pid: 200, start: "2000" });
  assertEquals(coordinatorFrom(700, read), { pid: 600, start: "6000" }, "the nearest, not the outermost");
  assertEquals(coordinatorFrom(900, read), null);
  assertEquals(coordinatorFrom(12345, read), null, "a process that is not there");
  assertEquals(coordinatorFrom(1, read), null);
  // a loop in the table (cannot happen, must not hang)
  assertEquals(coordinatorFrom(10, table({ 10: [11, "a", "1"], 11: [10, "b", "1"] })), null);
});

Deno.test("proc: procAlive — same start is the same process, another start is a reused pid", () => {
  const read = table({ 200: [1, "claude-bin", "2000"] });
  assert(procAlive({ pid: 200, start: "2000" }, read));
  assert(procAlive({ pid: 200, start: "2001" }, read), "a second off: the boot time moved with the clock");
  assert(!procAlive({ pid: 200, start: "2100" }, read), "pid reused");
  assert(!procAlive({ pid: 201, start: "2000" }, read), "gone");
  assert(!procAlive(undefined, read));
  assert(!procAlive({ pid: 0, start: "" }, read));
});

Deno.test("proc: this very process is read back, and a coordinator's liveness follows it", () => {
  const me = procReader(Deno.pid);
  assert(me && /^\d+$/.test(me.start) && Math.abs(Number(me.start) - Date.now() / 1000) < 86400 * 400);
  assert(procAlive({ pid: Deno.pid, start: me.start }));
  const mine = myCoordinator(); // under `claude` here or not: either way a coherent answer
  assert(mine === null || procAlive(mine));
});
