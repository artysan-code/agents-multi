// Tests for apps/cli/console/runs.ts: the hub's runs and agents as the Runs page shows them.
import { assertEquals } from "jsr:@std/assert@1";
import { type AgentRow, recentAgents, runRow, sortRuns } from "../console/runs.ts";
import type { Run } from "../../../shared/mcp/lib/runs.ts";

Deno.test("runRow: the steps in the plan's order, a step not started yet is waiting", () => {
  const r = {
    id: "fix-1",
    plan: {
      name: "fix",
      folder: "/x",
      steps: [{ id: "a", profile: "work", prompt: "p" }, { id: "b", profile: "work", prompt: "q" }],
    },
    state: {
      status: "running",
      steps: { a: { status: "failed", attempt: 1, started: "2026-10-15T09:00:00Z", error: "boom" } },
      control: 0,
      heard: {},
    },
    alive: false,
    project: "/x",
  } as unknown as Run;
  assertEquals(runRow(r), {
    id: "fix-1",
    name: "fix",
    status: "running",
    alive: false,
    project: "/x",
    started: "2026-10-15T09:00:00Z",
    steps: [{ id: "a", profile: "work", status: "failed", error: "boom" }, {
      id: "b",
      profile: "work",
      status: "waiting",
    }],
  });
});

Deno.test("sortRuns: the running first, then the newest", () => {
  const row = (id: string, status: string, started: string | null) => ({
    id,
    name: id,
    status,
    alive: true,
    started,
    steps: [],
  });
  const rows = [row("a", "done", "2026-10-15"), row("b", "running", "2026-10-01"), row("c", "done", "2026-10-16")];
  assertEquals(sortRuns(rows).map((r) => r.id), ["b", "c", "a"]);
});

Deno.test("recentAgents: everyone still up, the ended of the last week, newest first", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const a = (id: string, phase: string, started: string): AgentRow => ({
    id,
    profile: "work",
    provider: "claude",
    dir: "/x",
    task: "t",
    started,
    phase,
    turns: 1,
    pending: 0,
    said: null,
    error: null,
  });
  const rows = [
    a("old-ended", "ended", "2026-09-01T00:00:00Z"),
    a("old-up", "idle", "2026-09-01T00:00:00Z"),
    a("new-ended", "ended", "2026-10-14T00:00:00Z"),
    a("new-up", "working", "2026-10-15T00:00:00Z"),
  ];
  assertEquals(recentAgents(rows, now).map((r) => r.id), ["new-up", "old-up", "new-ended"]);
  assertEquals(recentAgents(rows, now, 1).map((r) => r.id), ["new-up"]);
});
