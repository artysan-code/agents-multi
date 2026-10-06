// Tests for usage.ts: rates, time windows, ingest with chunk dedupe, reports.
import { assert, assertAlmostEquals, assertEquals } from "jsr:@std/assert@1";
import { costUsd, ingestFile, openDb, projectLabel, report, sessions, sinceDate } from "../usage.ts";

Deno.test("sinceDate: 7d, all, an explicit date, and invalid input", () => {
  const d = sinceDate("7d")!;
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d));
  const diff = (Date.now() - new Date(d).getTime()) / 864e5;
  assert(diff >= 6.9 && diff <= 8.1, `7d → ${d} (${diff.toFixed(1)} giorni fa)`);
  assertEquals(sinceDate("all"), null);
  assertEquals(sinceDate(undefined), null);
  assertEquals(sinceDate("2026-09-01"), "2026-09-01");
  let threw = false;
  try {
    sinceDate("ieri");
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("costUsd: list price, cache read/write, the flat Fable read rate, an unknown model", () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 };
  assertAlmostEquals(costUsd("claude-opus-5", u)!, 5);
  assertAlmostEquals(costUsd("claude-sonnet-5", { ...u, input: 0, output: 1_000_000 })!, 10);
  assertAlmostEquals(costUsd("claude-opus-5", { ...u, input: 0, cacheRead: 1_000_000 })!, 0.5); // 0.1× input
  assertAlmostEquals(costUsd("claude-fable-5-1", { ...u, input: 0, cacheRead: 1_000_000 })!, 0.25); // flat
  assertAlmostEquals(costUsd("claude-opus-5", { ...u, input: 0, cache5m: 1_000_000 })!, 6.25); // 1.25×
  assertAlmostEquals(costUsd("claude-opus-5", { ...u, input: 0, cache1h: 1_000_000 })!, 10); // 2×
  assertEquals(costUsd("claude-nuovo-9", u), null);
});

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const usage = (input: number, output: number, read = 0, w5 = 0, w1 = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 },
});

Deno.test("ingestFile: dedupe by message.id (max per field), sidechains, synthetic models, Agent spawns", async () => {
  const dir = await Deno.makeTempDir();
  const f = `${dir}/session.jsonl`;
  await Deno.writeTextFile(
    f,
    [
      line({ type: "user", uuid: "u1", timestamp: "2026-09-04T10:00:00Z", message: { role: "user", content: "ciao" } }),
      // same response split across 2 chunks: input equal, output grows → counted ONCE, at the maximum
      line({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-09-04T10:00:01Z",
        sessionId: "s1",
        cwd: "/x",
        message: {
          id: "msg_1",
          model: "claude-opus-5",
          usage: usage(10, 100, 1000),
          content: [{ type: "text", text: "a" }],
        },
      }),
      line({
        type: "assistant",
        uuid: "a2",
        timestamp: "2026-09-04T10:00:02Z",
        sessionId: "s1",
        cwd: "/x",
        message: {
          id: "msg_1",
          model: "claude-opus-5",
          usage: usage(10, 300, 1000),
          content: [{
            type: "tool_use",
            name: "Agent",
            id: "toolu_1",
            input: { subagent_type: "Explore", description: "cerca" },
          }],
        },
      }),
      // subagent (sidechain) with attribution
      line({
        type: "assistant",
        uuid: "a3",
        isSidechain: true,
        attributionAgent: "Explore",
        agentId: "ag1",
        timestamp: "2026-09-04T10:01:00Z",
        sessionId: "s1",
        message: { id: "msg_2", model: "claude-sonnet-5", usage: usage(5, 50), content: [] },
      }),
      // synthetic: ignorato
      line({
        type: "assistant",
        uuid: "a4",
        timestamp: "2026-09-04T10:02:00Z",
        sessionId: "s1",
        message: { id: "msg_3", model: "<synthetic>", usage: usage(1, 1), content: [] },
      }),
      "riga non json",
    ].join("\n"),
  );
  const db = openDb(":memory:");
  const n = await ingestFile(db, "personal", f);
  assertEquals(n, 2);
  const rows = db.prepare("SELECT msg_id, agent, sidechain, model, output, cache_read FROM messages ORDER BY msg_id")
    .all() as Record<string, unknown>[];
  assertEquals(rows.length, 2);
  assertEquals(rows[0], {
    msg_id: "msg_1",
    agent: "main",
    sidechain: 0,
    model: "claude-opus-5",
    output: 300,
    cache_read: 1000,
  });
  assertEquals(rows[1].agent, "Explore");
  assertEquals(rows[1].sidechain, 1);
  const spawns = db.prepare("SELECT subagent_type, description FROM agent_spawns").all() as Record<string, unknown>[];
  assertEquals(spawns, [{ subagent_type: "Explore", description: "cerca" }]);
  // report per profile and per agent
  const r = report(db, { by: "profile", since: "all" });
  assertEquals(r.rows.length, 1);
  assertEquals(r.rows[0].key, "personal");
  assertEquals(r.total.output, 350);
  const a = report(db, { by: "agent", since: "all" }).rows.map((x) => x.key).sort();
  assertEquals(a, ["Explore", "main"]);
  // split: by day + profile
  const d = report(db, { by: "day", since: "all", split: "profile" });
  assertEquals(d.rows[0].day, "2026-09-04");
  assertEquals(d.rows[0].profile, "personal");
  // sessions: one row per session_id with duration, models and agents
  const ss = sessions(db, { since: "all" });
  assertEquals(ss.length, 1);
  assertEquals(ss[0].session_id, "s1");
  assertEquals(ss[0].minutes, 1);
  assertEquals(ss[0].models.sort(), ["claude-opus-5", "claude-sonnet-5"]);
  assertEquals(ss[0].sidechain_msgs, 1);
  // re-ingesting the same file is idempotent
  await ingestFile(db, "personal", f);
  assertEquals((db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c, 2);
  db.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("skill and command attribution: the turn, the split share, consecutive prompts", async () => {
  const dir = await Deno.makeTempDir();
  const f = `${dir}/session.jsonl`;
  const asst = (uuid: string, id: string, out: number, content: unknown[] = []) =>
    line({
      type: "assistant",
      uuid,
      timestamp: "2026-09-04T10:00:00Z",
      sessionId: "s1",
      cwd: "/x",
      message: { id, model: "claude-opus-5", usage: usage(0, out), content },
    });
  await Deno.writeTextFile(
    f,
    [
      // turn 1: human prompt → a single skill → it takes the whole cost
      line({
        type: "user",
        uuid: "t1",
        timestamp: "2026-09-04T10:00:00Z",
        sessionId: "s1",
        message: { role: "user", content: "fai una cosa" },
      }),
      asst("a1", "m1", 100, [{ type: "tool_use", name: "Skill", id: "u1", input: { skill: "dataviz" } }]),
      // a tool_result does not open a new turn: the cost that follows stays on t1
      line({
        type: "user",
        uuid: "r1",
        timestamp: "2026-09-04T10:00:05Z",
        sessionId: "s1",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "u1" }] },
      }),
      asst("a2", "m2", 100),
      // turn 2: slash command + its expansion (two consecutive user messages) → one turn, with 2 skills
      line({
        type: "user",
        uuid: "t2",
        timestamp: "2026-09-04T11:00:00Z",
        sessionId: "s1",
        message: { role: "user", content: "<command-name>/pr-forge</command-name>" },
      }),
      line({
        type: "user",
        uuid: "t2b",
        timestamp: "2026-09-04T11:00:01Z",
        sessionId: "s1",
        message: { role: "user", content: "istruzioni del comando" },
      }),
      asst("a3", "m3", 400, [{ type: "tool_use", name: "Skill", id: "u2", input: { skill: "dataviz" } }, {
        type: "tool_use",
        name: "Skill",
        id: "u3",
        input: { skill: "release-prod" },
      }]),
      // a subagent spawned inside the turn stays in the turn: its cost is the cost of the skill that used it
      line({
        type: "assistant",
        uuid: "a4",
        isSidechain: true,
        timestamp: "2026-09-04T11:01:00Z",
        sessionId: "s1",
        message: { id: "m4", model: "claude-opus-5", usage: usage(0, 999), content: [] },
      }),
    ].join("\n"),
  );
  const db = openDb(":memory:");
  await ingestFile(db, "personal", f);

  const sk = report(db, { by: "skill", since: "all" });
  const byKey = Object.fromEntries(sk.rows.map((r) => [r.key, r]));
  // turn 1 = 200 output, all to dataviz (single skill); turn 2 = 400 + 999 from the subagent, split across 2 skills
  assertAlmostEquals(byKey["dataviz"].output, 200 + 1399 / 2);
  assertEquals(byKey["dataviz"].uses, 2);
  assertAlmostEquals(byKey["release-prod"].output, 1399 / 2);
  assertEquals(byKey["release-prod"].uses, 1);
  // the command is the only one in turn 2: it takes that whole turn, subagent included
  const cm = report(db, { by: "command", since: "all" });
  assertEquals(cm.rows.length, 1);
  assertEquals(cm.rows[0].key, "pr-forge");
  assertEquals(cm.rows[0].output, 1399);
  assertEquals(sk.orphanMsgs, 0);
  // reingest: nessun doppione
  await ingestFile(db, "personal", f);
  assertEquals((db.prepare("SELECT COUNT(*) c FROM turn_tools").get() as { c: number }).c, 4);
  db.close();
  await Deno.remove(dir, { recursive: true });
});

Deno.test("projectLabel: cwd names the project, the slug is only a fallback", () => {
  assertEquals(projectLabel("-home-a-work-lead-qualifier", "/home/a/work/lead-qualifier"), "lead-qualifier");
  assertEquals(projectLabel("x", "/home/a/work/lead-qualifier/"), "lead-qualifier"); // trailing slash
  // no cwd: strip the slugified home and keep what is left, ambiguous as it is
  assertEquals(projectLabel("-home-a-dragons-lair", null).endsWith("dragons-lair"), true);
  assertEquals(projectLabel(null, null), "—");
});
