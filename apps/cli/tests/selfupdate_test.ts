// Tests for agents-multi updating itself (selfupdate.ts): when it pulls, and what a pull makes stale.
import { assertEquals } from "jsr:@std/assert@1";
import { remoteIsGone, selfPlan } from "../selfupdate.ts";
import { staleParts, staleUnits } from "../lib/stale.ts";

const R = { upstream: "origin/release", branch: "release", ahead: 0, behind: 0, dirty: 0 };

Deno.test("self-update: pulls only fast-forward on a clean tree that follows a remote branch", () => {
  assertEquals(selfPlan({ ...R, behind: 3 }), { do: "pull" });
  assertEquals(selfPlan(R).do, "nothing");
  assertEquals(selfPlan({ ...R, ahead: 2 }), { do: "nothing", why: "up to date (2 commits of yours not pushed)" });
  assertEquals(selfPlan({ ...R, behind: 3, dirty: 1 }).do, "skip");
  assertEquals(selfPlan({ ...R, behind: 3, ahead: 1 }).do, "skip");
  assertEquals(selfPlan({ ...R, upstream: null, behind: 3 }).do, "skip");
  // a dirty tree with nothing to take is simply up to date
  assertEquals(selfPlan({ ...R, dirty: 4 }).do, "nothing");
});

Deno.test("self-update: the console restarts for its code, the app for its own, tests and docs restart nothing", () => {
  assertEquals(staleParts(["apps/cli/serve.ts"]), { console: true, app: false });
  assertEquals(staleParts(["shared/mcp/lib/tasks.ts"]), { console: true, app: false });
  assertEquals(staleParts(["apps/ui/src/pages/today/index.tsx"]), { console: true, app: false });
  assertEquals(staleParts(["apps/tray/console.py"]), { console: false, app: true });
  assertEquals(staleParts(["apps/cli/tests/x_test.ts", "README.md", "apps/brain/main.ts"]), {
    console: false,
    app: false,
  });
});

Deno.test("self-update: the units to restart, the console last", () => {
  assertEquals(staleUnits(["apps/tray/console.py", "apps/cli/serve.ts"]), [
    "claude-multi-app.service",
    "claude-multi-console.service",
  ]);
  assertEquals(staleUnits(["CHANGELOG.md", "deno.json"]), []);
});

Deno.test("self-update: a renamed repository is told apart from a network that is down", () => {
  // what git prints for the old SSH URL of a renamed Forgejo repository
  assertEquals(
    remoteIsGone(
      "Forgejo: Cannot find repository: owner/claude-multi\n\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    ),
    true,
  );
  assertEquals(remoteIsGone("remote: Repository not found.\nfatal: repository 'https://x/y.git/' not found"), true);
  // the same closing lines follow a network failure too: they alone say nothing
  assertEquals(
    remoteIsGone(
      "ssh: Could not resolve hostname git.example: Name or service not known\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.",
    ),
    false,
  );
  assertEquals(remoteIsGone("fatal: unable to access 'https://x/': Could not resolve host: x"), false);
});
