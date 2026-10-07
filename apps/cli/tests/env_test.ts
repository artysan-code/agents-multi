import { assertEquals } from "@std/assert";
import { amEnv, amEnvBoth } from "../../../shared/mcp/lib/env.ts";

Deno.test("amEnv: the new name wins, the old one is the fallback, neither is undefined", () => {
  const names = ["AGENTS_MULTI_ZZ_TEST", "CLAUDE_MULTI_ZZ_TEST"];
  try {
    for (const n of names) Deno.env.delete(n);
    assertEquals(amEnv("ZZ_TEST"), undefined);
    Deno.env.set("CLAUDE_MULTI_ZZ_TEST", "old");
    assertEquals(amEnv("ZZ_TEST"), "old");
    Deno.env.set("AGENTS_MULTI_ZZ_TEST", "new");
    assertEquals(amEnv("ZZ_TEST"), "new");
    Deno.env.set("AGENTS_MULTI_ZZ_TEST", "");
    assertEquals(amEnv("ZZ_TEST"), "", "an empty new name is still set");
  } finally {
    for (const n of names) Deno.env.delete(n);
  }
});

Deno.test("amEnv: a server allowed only the old name reads it, a server allowed only the new one reads that", async () => {
  const run = async (allow: string, env: Record<string, string>) => {
    // `deno eval` runs with every permission, so the probe is a file run under a narrow --allow-env
    const dir = await Deno.makeTempDir();
    const script = `${dir}/probe.ts`;
    const lib = new URL("../../../shared/mcp/lib/env.ts", import.meta.url).href;
    await Deno.writeTextFile(script, `import { amEnv } from "${lib}"; console.log(amEnv("PROFILE") ?? "none");`);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--quiet", "--no-lock", `--allow-env=${allow}`, `--allow-read=${dir},${Deno.cwd()}`, script],
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Deno.remove(dir, { recursive: true });
    return new TextDecoder().decode(out.stdout).trim() +
      (out.success ? "" : ` | ${new TextDecoder().decode(out.stderr)}`);
  };
  assertEquals(await run("CLAUDE_MULTI_PROFILE", { CLAUDE_MULTI_PROFILE: "p", AGENTS_MULTI_PROFILE: "q" }), "p");
  assertEquals(await run("AGENTS_MULTI_PROFILE", { CLAUDE_MULTI_PROFILE: "p", AGENTS_MULTI_PROFILE: "q" }), "q");
  assertEquals(await run("AGENTS_MULTI_PROFILE,CLAUDE_MULTI_PROFILE", { CLAUDE_MULTI_PROFILE: "p" }), "p");
});

Deno.test("amEnvBoth: the same value under the new and the old name", () => {
  assertEquals(amEnvBoth("PROFILE", "x"), { AGENTS_MULTI_PROFILE: "x", CLAUDE_MULTI_PROFILE: "x" });
});
