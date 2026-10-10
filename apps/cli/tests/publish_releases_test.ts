// Tests for scripts/publish-releases.ts: which tags get a Forgejo release, and with which notes.
import { assertEquals } from "jsr:@std/assert@1";
import { sectionOf, versionTags } from "../../../scripts/publish-releases.ts";

const LOG = `# Changelog

## [0.7.0] - 2026-10-07

### Added

- **console**: a wizard (dbc4c40)

## [0.6.0] - 2026-10-07

No user-facing changes.
`;

Deno.test("publish-releases: a version's notes are its section without the heading", () => {
  assertEquals(sectionOf(LOG, "0.7.0"), "### Added\n\n- **console**: a wizard (dbc4c40)");
  assertEquals(sectionOf(LOG, "0.6.0"), "No user-facing changes.");
  assertEquals(sectionOf(LOG, "0.5.0"), null);
});

Deno.test("publish-releases: version tags only, oldest first, a beta before its version", () => {
  assertEquals(versionTags(["v0.2.0", "v0.10.0", "v0.2.0-rc.1", "v0.2.0-beta.1", "latest", "0.3.0", "v0.1.0", ""]), [
    "v0.1.0",
    "v0.2.0-beta.1",
    "v0.2.0-rc.1",
    "v0.2.0",
    "v0.10.0",
  ]);
});
