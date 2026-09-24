// Tests for summarize() in status.ts: the tray icon's level and the lines behind it (pure).
import { assertEquals } from "jsr:@std/assert@1";
import { summarize } from "../status.ts";
import type { Check, CliProc } from "../lib.ts";

const check = (id: string, status: Check["status"]): Check => ({ id, status, msg: `msg ${id}` });
const proc = (embedded: boolean): CliProc => ({ pid: 1, profile: "p", cwd: null, embedded, version: null, session: null, model: null, lastActivity: null });
const base = {
  generatedAt: "2026-09-24T00:00:00.000Z",
  doctor: [] as Check[],
  update: null as Parameters<typeof summarize>[0]["update"],
  running: { cli: [] as CliProc[], desktop: [] as { pid: number; variant: string }[] },
};

Deno.test("summarize: nothing wrong and nothing pending is ok", () => {
  const s = summarize({ ...base, doctor: [check("a", "ok")] });
  assertEquals(s.level, "ok");
  assertEquals(s.updates, { cli: null, desktop: null });
});

Deno.test("summarize: a warn is listed but does not colour the icon", () => {
  const s = summarize({ ...base, doctor: [check("a", "ok"), check("w", "warn")] });
  assertEquals(s.level, "ok");
  assertEquals(s.warns, ["msg w"]);
});

Deno.test("summarize: a pending update, unless that version was skipped", () => {
  const update = { cli: { current: "1.0.0", latest: "1.0.1", outdated: true }, desktop: { current: "2.0", latest: "2.0", outdated: false } };
  assertEquals(summarize({ ...base, update }).level, "update");
  assertEquals(summarize({ ...base, update }).updates, { cli: "1.0.1", desktop: null });
  const skipped = summarize({ ...base, update }, ["cli 1.0.1", ""]);
  assertEquals(skipped.level, "ok");
  assertEquals(skipped.updates.cli, null);
  // skipping another version does not hide this one
  assertEquals(summarize({ ...base, update }, ["cli 1.0.0", "desktop 1.0.1"]).updates.cli, "1.0.1");
});

Deno.test("summarize: a failure outranks a pending update", () => {
  const update = { desktop: { current: "2.0", latest: "2.1", outdated: true } };
  const s = summarize({ ...base, update, doctor: [check("f", "fail"), check("w", "warn")] });
  assertEquals(s.level, "fail");
  assertEquals(s.fails, ["msg f"]);
  assertEquals(s.updates.desktop, "2.1");
});

Deno.test("summarize: sessions embedded in Desktop count as Desktop, not as CLI", () => {
  const s = summarize({ ...base, running: { cli: [proc(false), proc(true), proc(false)], desktop: [{ pid: 2, variant: "p" }] } });
  assertEquals(s.running, { cli: 2, desktop: 1 });
});
