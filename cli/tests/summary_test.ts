// Tests for summarize() in status.ts: the tray icon's level and the lines behind it (pure).
import { assertEquals } from "jsr:@std/assert@1";
import { summarize } from "../status.ts";
import type { Check, CliProc } from "../lib.ts";

const check = (id: string, status: Check["status"]): Check => ({ id, status, msg: `msg ${id}` });
const proc = (embedded: boolean): CliProc => ({
  pid: 1,
  profile: "p",
  cwd: null,
  embedded,
  version: null,
  session: null,
  model: null,
  lastActivity: null,
});
const base = {
  generatedAt: "2026-09-24T00:00:00.000Z",
  doctor: [] as Check[],
  machine: { desktopStaged: null as string | null },
  running: { cli: [] as CliProc[], desktop: [] as { pid: number; variant: string }[] },
};

Deno.test("summarize: nothing wrong is ok", () => {
  const s = summarize({ ...base, doctor: [check("a", "ok")] });
  assertEquals(s.level, "ok");
  assertEquals(s.staged, null);
});

Deno.test("summarize: a warn is listed but does not colour the icon", () => {
  const s = summarize({ ...base, doctor: [check("a", "ok"), check("w", "warn")] });
  assertEquals(s.level, "ok");
  assertEquals(s.warns, ["msg w"]);
});

Deno.test("summarize: a staged Desktop is information, not a state to act on", () => {
  const s = summarize({ ...base, machine: { desktopStaged: "2.1.0" } });
  assertEquals([s.level, s.staged], ["ok", "2.1.0"]);
});

Deno.test("summarize: a failure turns it red", () => {
  const s = summarize({ ...base, doctor: [check("f", "fail"), check("w", "warn")] });
  assertEquals(s.level, "fail");
  assertEquals(s.fails, ["msg f"]);
});

Deno.test("summarize: sessions embedded in Desktop count as Desktop, not as CLI", () => {
  const s = summarize({
    ...base,
    running: { cli: [proc(false), proc(true), proc(false)], desktop: [{ pid: 2, variant: "p" }] },
  });
  assertEquals(s.running, { cli: 2, desktop: 1 });
});
