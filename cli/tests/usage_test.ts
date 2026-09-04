// Test di usage.ts: tariffe, finestre temporali, ingest con dedupe dei chunk, report.
import { assert, assertEquals, assertAlmostEquals } from "jsr:@std/assert@1";
import { costUsd, ingestFile, openDb, report, sinceDate } from "../usage.ts";

Deno.test("sinceDate: 7d, all, data esplicita, input non valido", () => {
  const d = sinceDate("7d")!;
  assert(/^\d{4}-\d{2}-\d{2}$/.test(d));
  const diff = (Date.now() - new Date(d).getTime()) / 864e5;
  assert(diff >= 6.9 && diff <= 8.1, `7d → ${d} (${diff.toFixed(1)} giorni fa)`);
  assertEquals(sinceDate("all"), null);
  assertEquals(sinceDate(undefined), null);
  assertEquals(sinceDate("2026-09-01"), "2026-09-01");
  let threw = false; try { sinceDate("ieri"); } catch { threw = true; } assert(threw);
});

Deno.test("costUsd: listino, cache read/write, Fable read flat, modello ignoto", () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cache5m: 0, cache1h: 0 };
  assertAlmostEquals(costUsd("claude-opus-5", u)!, 5);
  assertAlmostEquals(costUsd("claude-sonnet-5", { ...u, input: 0, output: 1_000_000 })!, 10);
  assertAlmostEquals(costUsd("claude-opus-5", { ...u, input: 0, cacheRead: 1_000_000 })!, 0.5);   // 0.1× input
  assertAlmostEquals(costUsd("claude-fable-5-1", { ...u, input: 0, cacheRead: 1_000_000 })!, 0.25); // flat
  assertAlmostEquals(costUsd("claude-opus-5", { ...u, input: 0, cache5m: 1_000_000 })!, 6.25);  // 1.25×
  assertAlmostEquals(costUsd("claude-opus-5", { ...u, input: 0, cache1h: 1_000_000 })!, 10);    // 2×
  assertEquals(costUsd("claude-nuovo-9", u), null);
});

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const usage = (input: number, output: number, read = 0, w5 = 0, w1 = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 } });

Deno.test("ingestFile: dedupe per message.id (max per campo), sidechain, synthetic, spawn Agent", async () => {
  const dir = await Deno.makeTempDir();
  const f = `${dir}/session.jsonl`;
  await Deno.writeTextFile(f, [
    line({ type: "user", uuid: "u1", timestamp: "2026-09-04T10:00:00Z", message: { role: "user", content: "ciao" } }),
    // stessa risposta in 2 chunk: input uguale, output cresce → si conta UNA volta col massimo
    line({ type: "assistant", uuid: "a1", timestamp: "2026-09-04T10:00:01Z", sessionId: "s1", cwd: "/x", message: { id: "msg_1", model: "claude-opus-5", usage: usage(10, 100, 1000), content: [{ type: "text", text: "a" }] } }),
    line({ type: "assistant", uuid: "a2", timestamp: "2026-09-04T10:00:02Z", sessionId: "s1", cwd: "/x", message: { id: "msg_1", model: "claude-opus-5", usage: usage(10, 300, 1000), content: [{ type: "tool_use", name: "Agent", id: "toolu_1", input: { subagent_type: "Explore", description: "cerca" } }] } }),
    // subagent (sidechain) con attribuzione
    line({ type: "assistant", uuid: "a3", isSidechain: true, attributionAgent: "Explore", agentId: "ag1", timestamp: "2026-09-04T10:01:00Z", sessionId: "s1", message: { id: "msg_2", model: "claude-sonnet-5", usage: usage(5, 50), content: [] } }),
    // synthetic: ignorato
    line({ type: "assistant", uuid: "a4", timestamp: "2026-09-04T10:02:00Z", sessionId: "s1", message: { id: "msg_3", model: "<synthetic>", usage: usage(1, 1), content: [] } }),
    "riga non json",
  ].join("\n"));
  const db = openDb(":memory:");
  const n = await ingestFile(db, "personal", f);
  assertEquals(n, 2);
  const rows = db.prepare("SELECT msg_id, agent, sidechain, model, output, cache_read FROM messages ORDER BY msg_id").all() as Record<string, unknown>[];
  assertEquals(rows.length, 2);
  assertEquals(rows[0], { msg_id: "msg_1", agent: "main", sidechain: 0, model: "claude-opus-5", output: 300, cache_read: 1000 });
  assertEquals(rows[1].agent, "Explore"); assertEquals(rows[1].sidechain, 1);
  const spawns = db.prepare("SELECT subagent_type, description FROM agent_spawns").all() as Record<string, unknown>[];
  assertEquals(spawns, [{ subagent_type: "Explore", description: "cerca" }]);
  // report per profilo e per agente
  const r = report(db, { by: "profile", since: "all" });
  assertEquals(r.rows.length, 1); assertEquals(r.rows[0].key, "personal"); assertEquals(r.total.output, 350);
  const a = report(db, { by: "agent", since: "all" }).rows.map((x) => x.key).sort();
  assertEquals(a, ["Explore", "main"]);
  // split: by day + profile
  const d = report(db, { by: "day", since: "all", split: "profile" });
  assertEquals(d.rows[0].day, "2026-09-04"); assertEquals(d.rows[0].profile, "personal");
  // reingest dello stesso file: idempotente
  await ingestFile(db, "personal", f);
  assertEquals((db.prepare("SELECT COUNT(*) c FROM messages").get() as { c: number }).c, 2);
  db.close();
  await Deno.remove(dir, { recursive: true });
});
