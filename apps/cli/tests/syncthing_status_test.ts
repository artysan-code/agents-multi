import { assertEquals } from "jsr:@std/assert@1";
import { dbStatusProblem, expandHome, gitRisk } from "../../../shared/mcp/syncthing-status/logic.ts";

Deno.test("expandHome: only a leading ~ is expanded", () => {
  assertEquals(expandHome("~", "/h"), "/h");
  assertEquals(expandHome("~/Sync/a", "/h"), "/h/Sync/a");
  assertEquals(expandHome("/data/~/a", "/h"), "/data/~/a");
  assertEquals(expandHome("~user/a", "/h"), "~user/a");
  assertEquals(expandHome("~/a", ""), "~/a");
});

Deno.test("dbStatusProblem: error and invalid fields are reported", () => {
  assertEquals(dbStatusProblem({}), null);
  assertEquals(dbStatusProblem({ error: "folder path missing" }), "folder path missing");
  assertEquals(dbStatusProblem({ invalid: "x" }), "invalid: x");
  assertEquals(dbStatusProblem(null), "no status returned");
});

Deno.test("gitRisk: a failed git listing is never OK", () => {
  const base = { gitDirSynced: false, exposed: 0, truncated: false };
  assertEquals(gitRisk({ ...base, tracked: [] }).startsWith("🟢 OK"), true);
  assertEquals(gitRisk({ ...base, tracked: null, trackedError: "dubious ownership" }).startsWith("❔ ?"), true);
  assertEquals(
    gitRisk({ ...base, tracked: ["a", "b"], exposed: 1, truncated: true }).startsWith("🟡 WARN — 1+/2"),
    true,
  );
  assertEquals(gitRisk({ ...base, gitDirSynced: true, tracked: null }).startsWith("🔴 CRITICAL"), true);
});
