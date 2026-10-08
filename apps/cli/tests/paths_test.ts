import { assertEquals } from "@std/assert";
import { claudeSessionVars, forgetBackendOnly } from "../console/server.ts";
import { moveXdgDirs, xdgBases } from "../lib/runtime-root.ts";

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

Deno.test("xdgBases: the environment's, an empty one falling back to the spec's defaults", () => {
  const env: Record<string, string> = { XDG_CACHE_HOME: "/c", XDG_STATE_HOME: "" };
  assertEquals(xdgBases((n) => env[n], "/h"), { cache: "/c", state: "/h/.local/state", data: "/h/.local/share" });
});

Deno.test("moveXdgDirs: the old folder becomes the new one, its name a link; a second run does nothing", async () => {
  const base = await Deno.makeTempDir();
  await Deno.mkdir(`${base}/claude-multi/sub`, { recursive: true });
  await Deno.writeTextFile(`${base}/claude-multi/log.jsonl`, "a\n");
  assertEquals(await moveXdgDirs([base, `${base}/none`]), [`${base}/claude-multi`]);
  assertEquals(await Deno.readTextFile(`${base}/agents-multi/log.jsonl`), "a\n");
  assertEquals(await Deno.readLink(`${base}/claude-multi`), "agents-multi");
  // old code writing under the old name lands in the new folder
  await Deno.writeTextFile(`${base}/claude-multi/late.json`, "{}");
  assertEquals(await Deno.readTextFile(`${base}/agents-multi/late.json`), "{}");
  assertEquals(await moveXdgDirs([base]), []);
});

Deno.test("moveXdgDirs: both folders: the old one's own files move over, the clashing ones stay aside", async () => {
  const base = await Deno.makeTempDir();
  await Deno.mkdir(`${base}/claude-multi`);
  await Deno.mkdir(`${base}/agents-multi`);
  await Deno.writeTextFile(`${base}/claude-multi/usage.db`, "old db");
  await Deno.writeTextFile(`${base}/claude-multi/app.json`, "stale");
  await Deno.writeTextFile(`${base}/agents-multi/app.json`, "fresh");
  await moveXdgDirs([base]);
  assertEquals(await Deno.readTextFile(`${base}/agents-multi/usage.db`), "old db");
  assertEquals(await Deno.readTextFile(`${base}/agents-multi/app.json`), "fresh");
  assertEquals(await Deno.readTextFile(`${base}/claude-multi.pre-agents-multi/app.json`), "stale");
  assertEquals(await Deno.readLink(`${base}/claude-multi`), "agents-multi");
  // nothing clashing: the emptied old folder goes, no copy aside
  const b2 = await Deno.makeTempDir();
  await Deno.mkdir(`${b2}/claude-multi`);
  await Deno.mkdir(`${b2}/agents-multi`);
  await Deno.writeTextFile(`${b2}/claude-multi/x`, "");
  await moveXdgDirs([b2]);
  assertEquals((await Array.fromAsync(Deno.readDir(b2))).map((e) => e.name).sort(), ["agents-multi", "claude-multi"]);
});
