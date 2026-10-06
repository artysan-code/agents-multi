// Tests for the profile manifests of the configuration (apps/cli/tests/fixtures/config when run by
// deno task test): shape, defaults, and agreement with shared/
// (every selected entry has to exist). Written against whatever profiles the repository declares,
// so adding or removing one does not break the suite.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BIN,
  commandOf,
  KINDS,
  launchers,
  loadManifest,
  ownItems,
  profileNames,
  REPO,
  RUNTIME,
  zshBlock,
} from "../lib.ts";
import { desktopEntry } from "../install.ts";

Deno.test("manifest: every profile has a valid profile.json and its selections exist in shared/", async () => {
  const profiles = await profileNames();
  assert(profiles.length > 0, "the configuration declares no profiles");
  for (const p of profiles) {
    const m = await loadManifest(p);
    for (const k of KINDS) {
      const spec = m[k];
      assert(spec === "all" || Array.isArray(spec), `${p}.${k}: expected "all" or a list`);
      if (Array.isArray(spec)) {
        for (const n of spec) {
          const name = k === "skills" || n.endsWith(".md") ? n : `${n}.md`;
          let ok = true;
          try {
            await Deno.lstat(`${REPO}/shared/${k}/${name}`);
          } catch {
            ok = false;
          }
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
    assert(
      m.desktopDir.startsWith("~/") || m.desktopDir.startsWith("/"),
      `${p}: desktopDir must be absolute or ~-relative, got "${m.desktopDir}"`,
    );
  }
});

Deno.test('manifest: a profile with no file falls back to "all" everywhere', async () => {
  const m = await loadManifest("does-not-exist");
  assertEquals(m, { skills: "all", agents: "all", commands: "all" });
});

Deno.test("launchers: every profile gets a command, unique across profiles", async () => {
  const ls = await launchers();
  assertEquals(ls.length, (await profileNames()).length);
  const seen = new Set<string>();
  for (const l of ls) {
    assert(l.command.length > 0, `${l.profile}: empty command`);
    assert(!seen.has(l.command), `two profiles answer to "${l.command}"`);
    seen.add(l.command);
  }
  // Aliases must be distinct too, or the ~/.zshrc block would shadow one with the other.
  const aliases = ls.map((l) => l.alias).filter(Boolean);
  assertEquals(new Set(aliases).size, aliases.length, "duplicate alias across profiles");
});

Deno.test("commandOf: the manifest wins, otherwise claude-<name>", () => {
  const base = { skills: "all", agents: "all", commands: "all" } as const;
  assertEquals(commandOf("acme", { ...base }), "claude-acme");
  assertEquals(commandOf("acme", { ...base, command: "claude-oto" }), "claude-oto");
  // A blank command is not a command: fall back rather than link an empty name.
  assertEquals(commandOf("acme", { ...base, command: "  " }), "claude-acme");
});

Deno.test("launchers: exactly one profile answers to the bare `claude` default", async () => {
  const defaults = (await launchers()).filter((l) => l.command === "claude");
  assert(defaults.length <= 1, "more than one profile claims the bare `claude` command");
});

Deno.test("zshBlock: one alias line per declared alias, default profile exported", async () => {
  const block = await zshBlock();
  const ls = await launchers();
  for (const l of ls) {
    if (l.alias) assert(block.includes(`alias ${l.alias}='${l.command}'`), `missing alias for ${l.profile}`);
    assert(block.includes(l.command), `${l.command} not mentioned in the block`);
  }
  const def = ls.find((l) => l.command === "claude") ?? ls[0];
  assert(
    block.includes(`CLAUDE_CONFIG_DIR:-${RUNTIME}/${def.profile}}`),
    "the default profile is not the exported CLAUDE_CONFIG_DIR",
  );
  // No profile name may be hardcoded: the block must be shorter than the sum of its parts.
  assertEquals(block.split("\n").filter((x) => x.startsWith("alias ")).length, ls.filter((l) => l.alias).length);
});

Deno.test("desktopEntry: one hidden entry per profile, scheme handler only on the default", async () => {
  const tpl = await Deno.readTextFile(`${REPO}/desktop/entry.desktop.in`);
  const body = tpl.slice(tpl.indexOf("[Desktop Entry]"));
  const ls = await launchers();
  const def = ls.find((l) => l.command === "claude")?.profile;
  const files = new Set<string>();
  for (const { profile } of ls) {
    const e = await desktopEntry(profile, body, def);
    // Nothing may reach the applications menu with a placeholder still in it.
    assert(!/@[A-Z]+@/.test(e.text), `${profile}: unsubstituted placeholder in ${e.file}`);
    assert(e.text.includes(`Exec=${BIN}/claude-launch ${profile} %U`), `${profile}: wrong Exec`);
    assert(!files.has(e.file), `two profiles write ${e.file}`);
    files.add(e.file);
    const claimsScheme = e.text.includes("MimeType=x-scheme-handler/claude;");
    assertEquals(claimsScheme, profile === def, `${profile}: claude:// handler on the wrong profile`);
    // Out of the menu: the single «Claude» entry (claude-multi-launcher.desktop) asks which profile.
    assert(e.text.includes("\nNoDisplay=true\n"), `${profile}: still listed in the menu`);
    // A variant needs its own app_id, or KDE groups it with the system build.
    if (e.variant) {
      assert(e.text.includes(`StartupWMClass=claude-desktop-${profile}`), `${profile}: no distinct app_id`);
    }
  }
});
