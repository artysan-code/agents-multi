// Tests for «Claude now» (apps/cli/live.ts): the limits in one shape from the status line or the endpoint,
// and the view — a profile's newest limits, whoever wrote them, and each session's newest context.
import { assertEquals } from "jsr:@std/assert@1";
import { limitOf, limitsOf, liveView, type Snapshot } from "../live.ts";

Deno.test("limitOf: the status line's percentage and seconds, the endpoint's utilization and ISO date", () => {
  assertEquals(limitOf({ used_percentage: 41.53, resets_at: 1791560000 }), { used: 41.5, resets: 1791560000 });
  assertEquals(limitOf({ utilization: 18, resets_at: "2026-10-12T10:00:00Z" }), {
    used: 18,
    resets: Date.parse("2026-10-12T10:00:00Z") / 1000,
  });
  assertEquals(limitOf({ utilization: 7, resets_at: null }), { used: 7, resets: null });
  assertEquals(limitOf({ resets_at: 1 }), undefined);
  assertEquals(limitOf(null), undefined);
});

Deno.test("limitsOf: the two windows when there, nothing when neither is", () => {
  assertEquals(limitsOf({ five_hour: { utilization: 3 }, seven_day_opus: { utilization: 9 } }), {
    five_hour: { used: 3, resets: null },
  });
  assertEquals(limitsOf({ seven_day_opus: { utilization: 9 } }), undefined);
});

Deno.test("liveView: a profile's newest limits, whoever wrote them; each session's newest; today's tokens", () => {
  const lim = (used: number) => ({ five_hour: { used, resets: null } });
  const snaps: Snapshot[] = [
    { at: 300, profile: "otacon", limits: lim(50), source: "endpoint" },
    { at: 100, profile: "otacon", session: "s1", limits: lim(10), context: { used: 20, size: 200000, tokens: 40000 } },
    { at: 200, profile: "otacon", session: "s1", context: { used: 30, size: 200000, tokens: 60000 }, model: "Opus" },
    { at: 150, profile: "ghost", limits: lim(99) },
  ];
  const v = liveView(snaps, ["otacon", "personal"], { otacon: 1200 });
  assertEquals(v.profiles.otacon, { limits: lim(50), at: 300, source: "endpoint", tokens: 1200 });
  assertEquals(v.profiles.personal, { limits: null, at: null, source: null, tokens: 0 });
  assertEquals(v.profiles.ghost, undefined);
  assertEquals(v.sessions.s1, {
    context: { used: 30, size: 200000, tokens: 60000 },
    model: "Opus",
    at: 200,
    cwd: null,
  });
});
