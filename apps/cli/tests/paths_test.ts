import { assertEquals } from "@std/assert";
import { claudeSessionVars, forgetBackendOnly } from "../console/server.ts";

Deno.test("REPO: the folder the code is in, decoded: the app's bundled copy sits under «Agents Multi»", async () => {
  // REPO is computed at import: a copy of paths.ts and what it imports, in a folder with a space
  const root = `${await Deno.makeTempDir()}/Agents Multi/repo`;
  const here = new URL("../../..", import.meta.url).pathname;
  for (const f of ["apps/cli/lib/paths.ts", "apps/cli/lib/runtime-root.ts", "shared/mcp/lib/env.ts"]) {
    await Deno.mkdir(`${root}/${f.slice(0, f.lastIndexOf("/"))}`, { recursive: true });
    await Deno.copyFile(`${here}${f}`, `${root}/${f}`);
  }
  const paths = new URL(`file://${root}/apps/cli/lib/paths.ts`).href;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-config", `import { REPO } from "${paths}"; console.log(REPO);`],
    stdout: "piped",
  }).output();
  await Deno.remove(root.slice(0, root.indexOf("/Agents Multi")), { recursive: true });
  assertEquals(new TextDecoder().decode(out.stdout).trim(), root);
});

Deno.test("forgetBackendOnly: the variables the app named, and the list itself, leave the environment", () => {
  const env = new Map([["AGENTS_MULTI_BACKEND_ONLY", "DENO_DIR, DENO_NO_UPDATE_CHECK"], ["DENO_DIR", "/x"], [
    "DENO_NO_UPDATE_CHECK",
    "1",
  ], ["HOME", "/h"]]);
  forgetBackendOnly({ get: (k) => env.get(k), delete: (k) => void env.delete(k) });
  assertEquals([...env.keys()], ["HOME"]);
  const none = new Map([["DENO_DIR", "/mine"]]);
  forgetBackendOnly({ get: (k) => none.get(k), delete: (k) => void none.delete(k) });
  assertEquals([...none.keys()], ["DENO_DIR"], "without the list, nothing is forgotten");
});

Deno.test("claudeSessionVars: a Claude session's variables, not Agents Multi's or the desktop's", () => {
  assertEquals(
    claudeSessionVars([
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_AGENT_SDK_VERSION",
      "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_PID",
      "CLAUDE_EFFORT",
      "CLAUDE_MULTI_NO_ASSISTANT_TRAILER",
      "DBUS_SESSION_BUS_ADDRESS",
      "HOME",
    ]),
    [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_AGENT_SDK_VERSION",
      "CLAUDE_PREVIEW_CLASSIFIER_FLOOR",
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_PID",
      "CLAUDE_EFFORT",
    ],
  );
});
