import { assertEquals } from "@std/assert";

// REPO is computed at import, so each case runs in its own process with the environment it needs.
const paths = new URL("../lib/paths.ts", import.meta.url).href;
const checkout = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

async function repoWith(env: Record<string, string>) {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", `import { REPO } from "${paths}"; console.log(REPO);`],
    env: { HOME: Deno.env.get("HOME") ?? "/", PATH: Deno.env.get("PATH") ?? "", ...env },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test("REPO: the checkout this file is in, unless AGENTS_MULTI_REPO names another", async () => {
  assertEquals(await repoWith({}), checkout);
  assertEquals(await repoWith({ AGENTS_MULTI_REPO: "/srv/agents-multi" }), "/srv/agents-multi");
  // the name bin/lib/prelaunch.sh already read before the rename
  assertEquals(await repoWith({ CLAUDE_MULTI_REPO: "/srv/old" }), "/srv/old");
});
