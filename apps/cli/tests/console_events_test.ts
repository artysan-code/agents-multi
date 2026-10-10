// The console's live updates (console/events.ts) and its kept status report (console/status-cache.ts):
// which file changes are news, and how often a burst of them recomputes the report.
import { assertEquals } from "jsr:@std/assert@1";
import { topicOf } from "../console/events.ts";
import { StatusCache } from "../console/status-cache.ts";

const roots = { runtime: "/h/.agents-multi", state: "/h/.local/state/agents-multi", tasks: "/h/brains/tasks" };

Deno.test("topicOf: what Claude Code writes while it works is not news; config and credentials are", () => {
  const id = "0018d3b0-2222-435a-b5fd-30143829a819";
  assertEquals(topicOf(`/h/.agents-multi/personal/projects/-h-x/${id}.jsonl`, roots), { topic: "usage", session: id });
  for (
    const p of [
      "/h/.agents-multi/personal/security/log.txt",
      "/h/.agents-multi/personal/.claude.json",
      "/h/.agents-multi/personal/.claude.json.backup.123",
      "/h/.agents-multi/personal/history.jsonl",
      "/h/.agents-multi/funnel/shell-snapshots/s.sh",
      "/h/.agents-multi/funnel/projects/-h-x/memory/a.md",
      "/h/.agents-multi/personal/settings.json.tmp",
      "/h/.local/state/agents-multi/agents/x/events.jsonl",
      "/h/.local/state/agents-multi/live/personal.json",
    ]
  ) assertEquals(topicOf(p, roots), null, p);
  for (
    const p of [
      "/h/.agents-multi/personal/.credentials.json",
      "/h/.agents-multi/personal/settings.json",
      "/h/.agents-multi/personal/plugins/installed_plugins.json",
      "/h/.agents-multi/config/accounts.json",
      "/h/.local/state/agents-multi/updates.jsonl",
    ]
  ) assertEquals(topicOf(p, roots), { topic: "state" }, p);
  assertEquals(topicOf("/h/brains/tasks/items/t-1.md", roots), { topic: "tasks" });
});

Deno.test("StatusCache: a burst of changes is one computation per gap; fresh always waits", async () => {
  let clock = 0, runs = 0;
  const cache = new StatusCache(() => Promise.resolve({ n: ++runs }), 5000, () => clock);
  assertEquals((await cache.get(false)).report, { n: 1 });
  // a change right after a computation: the kept report is served, no new run yet
  cache.invalidate();
  clock = 1000;
  assertEquals((await cache.get(false)).report, { n: 1 });
  cache.invalidate();
  assertEquals((await cache.get(false)).report, { n: 1 });
  // after the gap the next request waits for one computation that covers both changes
  clock = 6000;
  assertEquals((await cache.get(false)).report, { n: 2 });
  assertEquals((await cache.get(false)).report, { n: 2 });
  // an action asks fresh: always a new report
  assertEquals((await cache.get(true)).report, { n: 3 });
  // the trailing computation scheduled in the burst runs on its own; let it finish
  await new Promise((r) => setTimeout(r, 5));
});
