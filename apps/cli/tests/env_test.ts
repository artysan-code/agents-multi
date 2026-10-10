import { assertEquals } from "@std/assert";
import { amEnv } from "../../../shared/mcp/lib/env.ts";

Deno.test("amEnv: AGENTS_MULTI_<name>, else undefined; the old name is not read", () => {
  const names = ["AGENTS_MULTI_ZZ_TEST", "CLAUDE_MULTI_ZZ_TEST"];
  try {
    for (const n of names) Deno.env.delete(n);
    assertEquals(amEnv("ZZ_TEST"), undefined);
    Deno.env.set("CLAUDE_MULTI_ZZ_TEST", "old");
    assertEquals(amEnv("ZZ_TEST"), undefined);
    Deno.env.set("AGENTS_MULTI_ZZ_TEST", "new");
    assertEquals(amEnv("ZZ_TEST"), "new");
    Deno.env.set("AGENTS_MULTI_ZZ_TEST", "");
    assertEquals(amEnv("ZZ_TEST"), "", "an empty value is still set");
  } finally {
    for (const n of names) Deno.env.delete(n);
  }
});

Deno.test("amEnv: a server not allowed the name reads it as not set", async () => {
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
  assertEquals(await run("AGENTS_MULTI_PROFILE", { AGENTS_MULTI_PROFILE: "q" }), "q");
  assertEquals(await run("HOME", { AGENTS_MULTI_PROFILE: "q" }), "none");
});
