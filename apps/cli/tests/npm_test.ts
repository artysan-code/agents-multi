// Tests for mcp/npm.ts: which packages the servers in use need, the prefix's package.json, and what the
// doctor says of an installed version.
import { assertEquals } from "jsr:@std/assert@1";
import { installedVersion, installNpm, npmPackages, npmProblem, toolsPackageJson } from "../mcp/npm.ts";
import { type Registry } from "../mcp/registry.ts";

const N8N = { package: "n8n-mcp", version: "2.92.1", bin: "n8n-mcp" };
const SB = { package: "@supabase/mcp-server-supabase", version: "0.13.0", bin: "mcp-server-supabase" };

Deno.test("npmPackages: those of the servers a profile reaches, once each, sorted", () => {
  const reg: Registry = {
    profiles: ["p"],
    accounts: [{ service: "n8n", name: "a", url: "https://a.example", profiles: ["p"] }],
    servers: {
      "n8n": { _service: "n8n", _npm: N8N },
      "n8n-copy": { _service: "n8n", _npm: N8N },
      "supabase": { _service: "supabase", _npm: SB }, // no account: nobody uses it
      "off": { _profiles: [], _npm: { package: "z", version: "1", bin: "z" } },
      "plain": { command: "deno" },
    },
  };
  assertEquals(npmPackages(reg), [N8N]);
  assertEquals(npmPackages({ ...reg, servers: { s: { _npm: SB }, n: { _npm: N8N } } }).map((p) => p.package), [
    "@supabase/mcp-server-supabase",
    "n8n-mcp",
  ]);
});

Deno.test("toolsPackageJson: exact versions, nothing else to keep in step", () => {
  const j = JSON.parse(toolsPackageJson([N8N, SB]));
  assertEquals(j.dependencies, { "n8n-mcp": "2.92.1", "@supabase/mcp-server-supabase": "0.13.0" });
  assertEquals(j.private, true);
  assertEquals(JSON.parse(toolsPackageJson([])).dependencies, {});
});

Deno.test("npmProblem: a missing package and a stale one say what to run", () => {
  assertEquals(npmProblem(N8N, "2.92.1", "~/t"), null);
  assertEquals(npmProblem(N8N, null, "~/t")?.includes("not installed"), true);
  assertEquals(npmProblem(N8N, "2.91.0", "~/t")?.includes("2.91.0"), true);
  assertEquals(npmProblem(N8N, null, "~/t")?.includes("agents install"), true);
});

Deno.test("installNpm: nothing to do when the prefix has the versions; a dry run changes nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await installedVersion(dir, "n8n-mcp"), null);
    const dry = await installNpm([N8N], dir, true);
    assertEquals(dry.length, 1);
    assertEquals(await Deno.stat(`${dir}/package.json`).catch(() => null), null);
    // as if installed
    await Deno.mkdir(`${dir}/node_modules/n8n-mcp`, { recursive: true });
    await Deno.writeTextFile(`${dir}/node_modules/n8n-mcp/package.json`, '{"version":"2.92.1"}');
    await Deno.writeTextFile(`${dir}/package.json`, toolsPackageJson([N8N]));
    assertEquals(await installedVersion(dir, "n8n-mcp"), "2.92.1");
    assertEquals(await installNpm([N8N], dir, false), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
