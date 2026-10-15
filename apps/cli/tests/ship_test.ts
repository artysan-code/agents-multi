// Tests for scripts/ship.ts: the arguments it takes and the steps a version goes out with.
import { assertEquals } from "jsr:@std/assert@1";
import { ciVerdict, parseArgs, shipSteps, untried } from "../../../scripts/ship.ts";

Deno.test("ship: a beta or an rc is cut on beta from dev and comes back to dev by fast-forward", () => {
  const runs = shipSteps("beta", "minor").map((s) => s.run.join(" "));
  assertEquals(runs[1], "git merge --ff-only dev");
  assertEquals(runs[2], "release beta minor");
  assertEquals(runs[3], "git push origin beta {tag}");
  assertEquals(runs.at(-2), "git merge --ff-only beta");
  assertEquals(shipSteps("rc").map((s) => s.run.join(" "))[2], "release rc");
});

Deno.test("ship: a stable version is cut on release from beta, and beta and dev take it after", () => {
  const runs = shipSteps("stable").map((s) => s.run.join(" "));
  assertEquals(runs.slice(0, 7), [
    "git checkout -q -B beta origin/beta",
    "git merge --ff-only dev",
    "git push origin beta",
    "git checkout -q -B release origin/release",
    "git merge --ff-only origin/beta",
    "release",
    "git push origin release {tag}",
  ]);
  assertEquals(runs.includes("git merge --ff-only release"), true);
  assertEquals(runs.at(-1), "git push origin dev");
});

Deno.test("ship: beta takes from dev for a stable only update manifests and merges", () => {
  assertEquals(untried(["", "chore(updates): v1.1.0-rc.8 on its update channels"]), []);
  assertEquals(untried(["fix(ui): a thing", "chore(updates): v1.1.0-rc.8 on its update channels"]), [
    "fix(ui): a thing",
  ]);
});

Deno.test("ship: only the kinds and targets release.ts knows", () => {
  assertEquals(parseArgs(["beta", "major", "--dry-run"]), {
    kind: "beta",
    aim: "major",
    dry: true,
    yes: false,
    localGate: false,
  });
  assertEquals(parseArgs(["stable", "--yes"]), {
    kind: "stable",
    aim: undefined,
    dry: false,
    yes: true,
    localGate: false,
  });
  assertEquals((parseArgs(["rc", "--local-gate"]) as { localGate: boolean }).localGate, true);
  assertEquals(typeof parseArgs(["rc", "minor"]), "string");
  assertEquals(typeof parseArgs(["patch"]), "string");
  assertEquals(typeof parseArgs([]), "string");
});

Deno.test("ship: CI's verdict from the note on the commit", () => {
  assertEquals(ciVerdict(null), null);
  assertEquals(ciVerdict(""), null);
  assertEquals(ciVerdict("ci ok 480\n"), "ok");
  assertEquals(ciVerdict("ci failed 481"), "failed");
  assertEquals(ciVerdict("ci failed 481\n\nci ok 482"), "ok"); // a later run, appended: the last one counts
  assertEquals(ciVerdict("something else"), null);
});
