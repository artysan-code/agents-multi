// Tests for scripts/ship.ts: the arguments it takes and the steps a version goes out with.
import { assertEquals } from "jsr:@std/assert@1";
import { parseArgs, shipSteps } from "../../../scripts/ship.ts";

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
  assertEquals(runs.slice(0, 4), [
    "git checkout -q -B release origin/release",
    "git merge --ff-only origin/beta",
    "release",
    "git push origin release {tag}",
  ]);
  assertEquals(runs.includes("git merge --ff-only release"), true);
  assertEquals(runs.at(-1), "git push origin dev");
});

Deno.test("ship: only the kinds and targets release.ts knows", () => {
  assertEquals(parseArgs(["beta", "major", "--dry-run"]), { kind: "beta", aim: "major", dry: true, yes: false });
  assertEquals(parseArgs(["stable", "--yes"]), { kind: "stable", aim: undefined, dry: false, yes: true });
  assertEquals(typeof parseArgs(["rc", "minor"]), "string");
  assertEquals(typeof parseArgs(["patch"]), "string");
  assertEquals(typeof parseArgs([]), "string");
});
