// Tests for disableAccountMcp: the --settings overlay bin/claude builds from the sync manifests
// (bin/lib/profiles.sh), its TypeScript mirror, and the manifest flag read from both sides.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { REPO } from "../lib/paths.ts";
import { syncedPluginNames, syncedPlugins } from "../lib/plugins.ts";
import { loadManifest, profileNames } from "../lib/profiles.ts";

const PROFILES_SH = `${REPO}/bin/lib/profiles.sh`;

async function sh(cmd: string) {
  const r = await new Deno.Command("bash", {
    args: ["-c", `set -euo pipefail; source "${PROFILES_SH}"; ${cmd}`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: r.code,
    out: new TextDecoder().decode(r.stdout).trim(),
    err: new TextDecoder().decode(r.stderr).trim(),
  };
}

/** A fake profile runtime with two sync buckets: a name in both, and a bucket with no plugins. */
async function fakeRuntime() {
  const dir = await Deno.makeTempDir();
  const bucket = async (id: string, manifest: unknown) => {
    await Deno.mkdir(`${dir}/plugins/synced/${id}`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/plugins/synced/${id}/manifest.json`,
      JSON.stringify(manifest, null, id === "b" ? 2 : 0),
    );
  };
  await bucket("a", {
    lastUpdated: 1,
    plugins: [{ name: "marketing", marketplaceName: "knowledge-work-plugins" }, { name: "data" }],
  });
  await bucket("b", { plugins: [{ name: "marketing", marketplaceName: "knowledge-work-plugins" }] });
  await bucket("c", { plugins: [] });
  return dir;
}

Deno.test("syncedPluginNames: names only, ignoring malformed entries", () => {
  assertEquals(syncedPluginNames({ plugins: [{ name: "marketing" }, { name: "" }, {}, null, { name: 3 }] }), [
    "marketing",
  ]);
  assertEquals(syncedPluginNames(null), []);
  assertEquals(syncedPluginNames({ plugins: "nope" }), []);
});

Deno.test("account overlay: every synced plugin disabled once, connectors off; bash and TS agree", async () => {
  const dir = await fakeRuntime();
  const r = await sh(`cm_account_mcp_settings "${dir}"`);
  assertEquals(r.code, 0, r.err);
  const overlay = JSON.parse(r.out);
  assertEquals(overlay, {
    disableClaudeAiConnectors: true,
    enabledPlugins: { "data@synced": false, "marketing@synced": false },
  });
  assertEquals(Object.keys(overlay.enabledPlugins).sort(), await syncedPlugins(dir));
  await Deno.remove(dir, { recursive: true });
});

Deno.test("account overlay: a profile with nothing synced still gets valid JSON", async () => {
  const dir = await Deno.makeTempDir();
  const r = await sh(`cm_account_mcp_settings "${dir}"`);
  assertEquals(r.code, 0, r.err);
  assertEquals(JSON.parse(r.out), { disableClaudeAiConnectors: true, enabledPlugins: {} });
  assertEquals(await syncedPlugins(dir), []);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("manifest: disableAccountMcp is a boolean, and bash reads it as TypeScript does", async () => {
  for (const p of await profileNames()) {
    const m = await loadManifest(p);
    assert(
      m.disableAccountMcp === undefined || typeof m.disableAccountMcp === "boolean",
      `${p}: disableAccountMcp must be true or false`,
    );
    const r = await sh(`cm_flag "${p}" disableAccountMcp && echo on || echo off`);
    assertEquals(r.out, m.disableAccountMcp ? "on" : "off", `${p}: bash and TypeScript disagree`);
  }
});
