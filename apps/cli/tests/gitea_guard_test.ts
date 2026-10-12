// Tests for shared/hooks/gitea-guard.ts: what is reversible passes, a merge or a delete asks.
import { assertEquals } from "jsr:@std/assert@1";
import { classify } from "../../../shared/hooks/gitea-guard.ts";

Deno.test("classify: reversible methods pass without a question", () => {
  for (const method of ["create", "update", "close", "reopen", "update_branch", "add_reviewers", "create_repo_label"]) {
    assertEquals(classify({ method }).decision, "allow", method);
  }
});

Deno.test("classify: a merge asks, however it is asked for", () => {
  assertEquals(classify({ method: "merge", pull_number: 3 }).decision, "ask");
  assertEquals(classify({ method: "MERGE" }).decision, "ask");
  assertEquals(classify({ method: "update", force_merge: true }).decision, "ask");
  assertEquals(classify({ method: "update", merge_when_checks_succeed: true }).decision, "ask");
});

Deno.test("classify: a deletion asks", () => {
  for (const method of ["delete", "delete_repo_label", "delete_column", "delete_time", "delete_stopwatch"]) {
    assertEquals(classify({ method }).decision, "ask", method);
  }
});

Deno.test("classify: a call it cannot read asks", () => {
  assertEquals(classify(undefined).decision, "ask");
  assertEquals(classify({}).decision, "ask");
  assertEquals(classify({ method: 3 }).decision, "ask");
});
