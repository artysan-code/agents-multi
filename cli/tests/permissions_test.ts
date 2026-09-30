// Tests for permissions.ts: what a rule is, and how a profile's list differs from the shared one.
import { assertEquals } from "jsr:@std/assert@1";
import { ruleDiff, validRule } from "../permissions.ts";

Deno.test("validRule: tool names with or without a specifier", () => {
  for (const r of ["Bash(git:*)", "Read(~/.aws/**)", "mcp__n8n__n8n_workflows", "WebFetch(domain:example.com)", "Edit"]) assertEquals(validRule(r), true, r);
  for (const r of ["", "git status", "(foo)", "Bash(", "rm -rf /"]) assertEquals(validRule(r), false, r);
});

Deno.test("ruleDiff: what a profile adds and drops; no own list is no difference", () => {
  assertEquals(ruleDiff(["a", "b"], undefined), null);
  assertEquals(ruleDiff(["a", "b"], ["a", "b"]), { added: [], dropped: [] });
  assertEquals(ruleDiff(["a", "b"], ["a", "c"]), { added: ["c"], dropped: ["b"] });
});
