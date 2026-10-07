// Tests for permissions.ts: what a rule is, and how a profile's list differs from the shared one.
import { assertEquals } from "jsr:@std/assert@1";
import { moveRule, ruleDiff, validRule } from "../permissions.ts";

Deno.test("validRule: tool names with or without a specifier", () => {
  for (
    const r of ["Bash(git:*)", "Read(~/.aws/**)", "mcp__n8n__n8n_workflows", "WebFetch(domain:example.com)", "Edit"]
  ) assertEquals(validRule(r), true, r);
  for (const r of ["", "git status", "(foo)", "Bash(", "rm -rf /"]) assertEquals(validRule(r), false, r);
});

Deno.test("ruleDiff: what a profile adds and drops; no own list is no difference", () => {
  assertEquals(ruleDiff(["a", "b"], undefined), null);
  assertEquals(ruleDiff(["a", "b"], ["a", "b"]), { added: [], dropped: [] });
  assertEquals(ruleDiff(["a", "b"], ["a", "c"]), { added: ["c"], dropped: ["b"] });
});

Deno.test("moveRule: leaves the source and joins the destination in one step, never twice", () => {
  const p = { allow: ["a", "b"], ask: ["c"], deny: ["d"] };
  assertEquals(moveRule(p, "allow", "deny", "a"), null);
  assertEquals(p, { allow: ["b"], ask: ["c"], deny: ["d", "a"] });
  // already at the destination: only removed from the source
  p.ask.push("d");
  assertEquals(moveRule(p, "ask", "deny", "d"), null);
  assertEquals(p.deny, ["d", "a"]);
  assertEquals(p.ask, ["c"]);
  // a list that does not exist yet is created
  const q: { allow?: string[]; ask?: string[] } = { ask: ["x"] };
  assertEquals(moveRule(q, "ask", "allow", "x"), null);
  assertEquals(q, { ask: [], allow: ["x"] });
});

Deno.test("moveRule: refuses what is not there, the same list and unknown lists, touching nothing", () => {
  const p = { allow: ["a"], ask: [], deny: [] } as Record<string, string[]>;
  assertEquals(moveRule(p, "ask", "deny", "a"), "a is not in ask");
  assertEquals(moveRule(p, "allow", "allow", "a"), "same list");
  assertEquals(moveRule(p, "allow", "nope" as never, "a"), "unknown list");
  assertEquals(p, { allow: ["a"], ask: [], deny: [] });
});
