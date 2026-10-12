#!/usr/bin/env -S deno run --quiet --no-lock
// gitea-guard.ts — PreToolUse hook on the consolidated write tools of the Gitea MCP.
//
// Those tools (`pull_request_write`, `label_write`, …) do many things behind one name, chosen by
// `method`, so a permission rule on the tool cannot tell opening a PR from merging it. This hook
// reads the method instead:
//   a merge (method `merge`, or `force_merge` / `merge_when_checks_succeed` set)  → ask
//   a deletion (method `delete…`)                                                  → ask
//   any other method it knows how to read                                          → allow
//   no method, or one that is not a string                                         → ask
// What reaches production or the server (files on a branch, tags, releases, actions, repositories)
// is not behind this hook: those tools stay in the registry's `_ask`.
// Registered by the registry (`_guard` on the gitea entry), generated into each profile's settings.

export type Decision = { decision: "allow" | "ask"; reason: string };

/** Pure: what to do with one call, from its arguments. */
export function classify(args: Record<string, unknown> | undefined): Decision {
  const method = args?.method;
  if (typeof method !== "string" || !method) {
    return { decision: "ask", reason: "Gitea: no method to read in this call." };
  }
  const m = method.toLowerCase();
  if (m.startsWith("delete")) {
    return { decision: "ask", reason: `Gitea: ${method} deletes: check it before it runs.` };
  }
  if (m === "merge" || args?.force_merge === true || args?.merge_when_checks_succeed === true) {
    return { decision: "ask", reason: "Gitea: this merges a pull request: check the target branch before it runs." };
  }
  return { decision: "allow", reason: `Gitea: ${method} is reversible.` };
}

if (import.meta.main) {
  let d: Decision;
  try {
    const input = JSON.parse(await new Response(Deno.stdin.readable).text());
    d = classify(input?.tool_input);
  } catch {
    d = { decision: "ask", reason: "Gitea: the guard could not read this call." };
  }
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: d.decision,
        permissionDecisionReason: d.reason,
      },
    }),
  );
}
