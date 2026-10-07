// Tests for lib/changelog.ts: the CHANGELOG sections the update wizard and the notification show.
import { assertEquals } from "jsr:@std/assert@1";
import { compareVersions, highlights, releases, releasesBetween } from "../lib/changelog.ts";

const LOG = `# Changelog

Preamble.

## [0.6.0] - 2026-10-07

### Added

- **release**: restart the console (8c43c50)
- a change without scope (1234567)

## [0.6.0-beta.1] - 2026-10-06

### Fixed

- **brain**: a fix (abcdef0)

## [0.5.0] - 2026-10-05

### Added

- **today**: calendars (b66a2d8)
`;

Deno.test("changelog: versions in order, a beta before its stable version", () => {
  assertEquals(compareVersions("0.6.0", "0.5.9"), 1);
  assertEquals(compareVersions("0.6.0-beta.1", "0.6.0"), -1);
  assertEquals(compareVersions("0.6.0-beta.2", "0.6.0-beta.1"), 1);
  assertEquals(compareVersions("v1.0.0", "1.0.0"), 0);
});

Deno.test("changelog: sections parsed newest first, with their date and body", () => {
  const rs = releases(LOG);
  assertEquals(rs.map((r) => r.version), ["0.6.0", "0.6.0-beta.1", "0.5.0"]);
  assertEquals(rs[0].date, "2026-10-07");
  assertEquals(rs[2].body, "### Added\n\n- **today**: calendars (b66a2d8)");
});

Deno.test("changelog: what is new after one version up to another", () => {
  assertEquals(releasesBetween(LOG, "0.5.0", "0.6.0").map((r) => r.version), ["0.6.0", "0.6.0-beta.1"]);
  assertEquals(releasesBetween(LOG, "0.6.0", "0.6.0"), []);
  // nothing newer than the code on disk, even when the changelog has it
  assertEquals(releasesBetween(LOG, "0.5.0", "0.6.0-beta.1").map((r) => r.version), ["0.6.0-beta.1"]);
  // without a starting point, the current version alone
  assertEquals(releasesBetween(LOG, null, "0.5.0").map((r) => r.version), ["0.5.0"]);
});

Deno.test("changelog: highlights are plain lines, and count the rest", () => {
  assertEquals(highlights(releases(LOG).slice(0, 2), 2), {
    lines: ["release: restart the console", "a change without scope"],
    more: 1,
  });
});
