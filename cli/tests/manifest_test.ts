// Tests for the profile manifests in the repository: shape, defaults, and agreement with shared/
// (every selected entry has to exist). Written against whatever profiles the repository declares,
// so adding or removing one does not break the suite.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { KINDS, loadManifest, ownItems, profileNames, REPO } from "../lib.ts";

Deno.test("manifest: every profile has a valid profile.json and its selections exist in shared/", async () => {
  const profiles = await profileNames();
  assert(profiles.length > 0, "the repository declares no profiles");
  for (const p of profiles) {
    const m = await loadManifest(p);
    for (const k of KINDS) {
      const spec = m[k];
      assert(spec === "all" || Array.isArray(spec), `${p}.${k}: expected "all" or a list`);
      if (Array.isArray(spec)) {
        for (const n of spec) {
          const name = k === "skills" || n.endsWith(".md") ? n : `${n}.md`;
          let ok = true;
          try { await Deno.lstat(`${REPO}/shared/${k}/${name}`); } catch { ok = false; }
          assert(ok, `${p}.${k}: "${n}" does not exist in shared/${k}`);
        }
      }
    }
  }
});

Deno.test("manifest: a selective profile only claims what it lists, plus what it owns", async () => {
  for (const p of await profileNames()) {
    const m = await loadManifest(p);
    for (const k of KINDS) {
      const spec = m[k];
      if (spec === "all") continue;
      const own = (await ownItems(p, k)).map((n) => n.replace(/\.md$/, ""));
      // A selective list plus owned items is what install materialises; a name appearing in both
      // would make the expected set ambiguous, and the doctor would report a phantom difference.
      for (const n of spec) assert(!own.includes(n), `${p}.${k}: "${n}" is both selected and owned`);
    }
  }
});

Deno.test("manifest: desktopDir, when set, is a path and not a bare name", async () => {
  for (const p of await profileNames()) {
    const m = await loadManifest(p);
    if (!m.desktopDir) continue;
    assert(m.desktopDir.startsWith("~/") || m.desktopDir.startsWith("/"), `${p}: desktopDir must be absolute or ~-relative, got "${m.desktopDir}"`);
  }
});

Deno.test('manifest: a profile with no file falls back to "all" everywhere', async () => {
  const m = await loadManifest("does-not-exist");
  assertEquals(m, { skills: "all", agents: "all", commands: "all" });
});
