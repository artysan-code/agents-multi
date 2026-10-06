// Tests for desktopVersions (lib.ts): which user-space Claude Desktop is in use, staged, or the
// rollback target, from the version directories and the `current` link.
import { assertEquals } from "jsr:@std/assert@1";
import { desktopVariantOf } from "../lib/processes.ts";
import { cmpVersion, desktopVersions } from "../lib/versions.ts";

Deno.test("cmpVersion: numeric, not lexical", () => {
  assertEquals(cmpVersion("2.10.0", "2.9.9") > 0, true);
  assertEquals(cmpVersion("2.9939.4", "2.9939.4"), 0);
  assertEquals(cmpVersion("1.2", "1.2.1") < 0, true);
});

Deno.test("desktopVersions: in use, staged above it, previous below it", () => {
  assertEquals(desktopVersions(["2.9.0", "2.10.0", "2.8.1"], "2.9.0"), {
    current: "2.9.0",
    staged: "2.10.0",
    previous: "2.8.1",
  });
  assertEquals(desktopVersions(["2.9.0", "2.8.1"], "2.9.0"), { current: "2.9.0", staged: null, previous: "2.8.1" });
});

Deno.test("desktopVersions: before the first switch everything extracted is staged", () => {
  assertEquals(desktopVersions(["2.9.0"], null), { current: null, staged: "2.9.0", previous: null });
  assertEquals(desktopVersions([], null), { current: null, staged: null, previous: null });
});

Deno.test("desktopVersions: temporary and foreign directories are ignored", () => {
  assertEquals(desktopVersions([".2.10.0.tmp", ".2.10.0.app", "junk", "2.9.0"], "2.9.0").staged, null);
  // a `current` pointing at something that is not a version directory counts as none
  assertEquals(desktopVersions(["2.9.0"], "versions").current, null);
});

Deno.test("desktopVariantOf: the user-space build is the default profile, a rebuilt one names its own", () => {
  const H = "/home/u/.local/lib";
  assertEquals(desktopVariantOf(`${H}/claude-desktop/versions/2.9939.4/claude-desktop`, "personal"), "personal");
  assertEquals(desktopVariantOf(`${H}/claude-desktop-client/claude-desktop-client`, "personal"), "client");
  assertEquals(desktopVariantOf("/usr/lib/claude-desktop/claude-desktop", "personal"), "personal");
  assertEquals(desktopVariantOf(`${H}/claude-desktop/versions/2.9939.4/chrome_crashpad_handler`, "personal"), null);
  assertEquals(desktopVariantOf("/home/u/.local/share/claude/versions/2.1.285", "personal"), null);
});
