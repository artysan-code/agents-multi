// Tests for scripts/release.ts: SemVer bumps with the cascading reset, betas, Conventional Commit
// parsing, the implied bump, the CHANGELOG section and the manifest rewrite.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  bump,
  changelogSection,
  formatVersion,
  impliedBump,
  lintSubject,
  parseCommit,
  parseVersion,
  prependSection,
  setManifestVersion,
} from "../../scripts/release.ts";

const next = (v: string, kind: Parameters<typeof bump>[1], target?: Parameters<typeof bump>[2]) =>
  formatVersion(bump(parseVersion(v), kind, target));

Deno.test("bump: a raised component resets the ones to its right", () => {
  assertEquals(next("0.1.24", "minor"), "0.2.0");
  assertEquals(next("0.2.0", "patch"), "0.2.1");
  assertEquals(next("0.2.4145", "major"), "1.0.0");
  assertEquals(next("v1.4.2", "patch"), "1.4.3");
});

Deno.test("bump: betas open on the target version, count up, and release that version", () => {
  assertEquals(next("0.2.0", "beta", "minor"), "0.3.0-beta.1");
  assertEquals(next("0.3.0-beta.1", "beta"), "0.3.0-beta.2");
  assertEquals(next("0.3.0-beta.2", "minor"), "0.3.0");
  assertEquals(next("0.9.3", "beta", "major"), "1.0.0-beta.1");
  assertEquals(next("1.0.0-beta.4", "patch"), "1.0.0");
});

Deno.test("parseVersion: rejects anything that is not X.Y.Z or X.Y.Z-beta.N", () => {
  assertThrows(() => parseVersion("1.2"));
  assertThrows(() => parseVersion("1.2.3-rc.1"));
});

const c = (subject: string, body = "", hash = "abcdef1234") => ({ hash, subject, body });

Deno.test("parseCommit: type, scope, breaking by ! or footer; other subjects are skipped", () => {
  assertEquals(parseCommit(c("feat(brain): rate limit on login")), {
    type: "feat",
    scope: "brain",
    breaking: false,
    description: "rate limit on login",
    hash: "abcdef1234",
  });
  assertEquals(parseCommit(c("refactor!: drop the PySide6 app"))?.breaking, true);
  assertEquals(parseCommit(c("fix: x", "BREAKING CHANGE: the config moved"))?.breaking, true);
  assertEquals(parseCommit(c("install, doctor: no machine-bound symlink")), null);
  assertEquals(parseCommit(c("Merge branch 'dev'")), null);
});

Deno.test("impliedBump: breaking → major (minor before 1.0), feat → minor, else patch", () => {
  const ch = (s: string) => parseCommit(c(s))!;
  assertEquals(impliedBump([ch("fix: a"), ch("feat: b")], parseVersion("1.2.0")), "minor");
  assertEquals(impliedBump([ch("feat!: b")], parseVersion("1.2.0")), "major");
  assertEquals(impliedBump([ch("feat!: b")], parseVersion("0.4.0")), "minor");
  assertEquals(impliedBump([ch("ci: a")], parseVersion("0.4.0")), "patch");
});

Deno.test("changelogSection: grouped, breaking first, housekeeping left out", () => {
  const changes = ["feat(app): tray icon", "fix: login loop", "ci: cache", "feat!: new config layout"]
    .map((s, i) => parseCommit(c(s, "", `${i}000000aaa`))!);
  assertEquals(
    changelogSection("0.2.0", "2026-10-06", changes),
    [
      "## [0.2.0] - 2026-10-06",
      "",
      "### Breaking changes",
      "",
      "- new config layout (3000000)",
      "",
      "### Added",
      "",
      "- **app**: tray icon (0000000)",
      "",
      "### Fixed",
      "",
      "- login loop (1000000)",
      "",
    ].join("\n"),
  );
  assertEquals(changelogSection("0.2.1", "2026-10-06", []).includes("No user-facing changes."), true);
});

Deno.test("prependSection: above the newest section, below the preamble", () => {
  const log = "# Changelog\n\nIntro.\n\n## [0.1.0] - 2026-10-06\n\n- first\n";
  assertEquals(
    prependSection(log, "## [0.2.0] - 2026-10-07\n\n- second\n"),
    "# Changelog\n\nIntro.\n\n## [0.2.0] - 2026-10-07\n\n- second\n\n## [0.1.0] - 2026-10-06\n\n- first\n",
  );
});

Deno.test("setManifestVersion: replaces the top-level version or adds it first, layout kept", () => {
  assertEquals(
    setManifestVersion('{\n  "name": "x",\n  "version": "0.1.0",\n  "deps": { "version": "9" }\n}\n', "0.2.0"),
    '{\n  "name": "x",\n  "version": "0.2.0",\n  "deps": { "version": "9" }\n}\n',
  );
  assertEquals(setManifestVersion('{\n  "tasks": {}\n}\n', "0.1.0"), '{\n  "version": "0.1.0",\n  "tasks": {}\n}\n');
});

Deno.test("lintSubject: known types, lowercase scopes, git's own subjects, 100 characters", () => {
  assertEquals(lintSubject("feat(brain/auth): rate limit"), null);
  assertEquals(lintSubject("fix!: config moved"), null);
  assertEquals(lintSubject("Merge branch 'dev' into beta"), null);
  assertEquals(lintSubject("install, doctor: no symlink") !== null, true);
  assertEquals(lintSubject("feature: x")?.startsWith("unknown type"), true);
  assertEquals(lintSubject("feat(Brain): x")?.includes("lowercase"), true);
  assertEquals(lintSubject(`docs: ${"a".repeat(100)}`)?.includes("at most 100"), true);
});
