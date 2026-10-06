// Tests for bin/claude-desktop-update against a throwaway root: a staged version waits while an
// instance runs, switches when none does, old versions are pruned, and rollback goes back. The
// network half (verification, download) is exercised by the real updater, not here.
import { assert, assertEquals } from "jsr:@std/assert@1";

const SCRIPT = new URL("../../bin/claude-desktop-update", import.meta.url).pathname;

async function setup(versions: string[], current: string | null) {
  const root = await Deno.makeTempDir();
  for (const v of versions) {
    await Deno.mkdir(`${root}/versions/${v}`, { recursive: true });
    await Deno.writeTextFile(`${root}/versions/${v}/claude-desktop`, "#!/bin/sh\n", { mode: 0o755 });
  }
  if (current) await Deno.symlink(`versions/${current}`, `${root}/current`);
  return root;
}

async function run(root: string, args: string[], running = false) {
  const out = await new Deno.Command("bash", {
    args: [SCRIPT, ...args],
    env: {
      CLAUDE_DESKTOP_ROOT: root,
      CM_DESKTOP_RUNNING: running ? "1" : "0",
      CLAUDE_DESKTOP_VARIANTS: "",
      CM_UPDATE_LOG: `${root}/log.jsonl`,
      QUIET: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, out: new TextDecoder().decode(out.stdout).trim() };
}
const current = async (root: string) => (await Deno.realPath(`${root}/current`)).split("/").pop();
const versions = (root: string) => [...Deno.readDirSync(`${root}/versions`)].map((e) => e.name).sort();
const log = async (root: string) =>
  (await Deno.readTextFile(`${root}/log.jsonl`)).trim().split("\n").map((l) => JSON.parse(l));

Deno.test("claude-desktop-update: a staged version waits while Desktop runs, then switches", async () => {
  const root = await setup(["1.0.0", "1.1.0"], "1.0.0");
  assertEquals((await run(root, ["--staged"])).out, "1.1.0");
  assertEquals((await run(root, ["--apply"], true)).code, 5);
  assertEquals(await current(root), "1.0.0");
  assertEquals((await run(root, ["--apply"])).code, 0);
  assertEquals(await current(root), "1.1.0");
  assertEquals((await run(root, ["--staged"])).out, "");
  const [e] = await log(root);
  assertEquals([e.component, e.event, e.from, e.to], ["desktop", "applied", "1.0.0", "1.1.0"]);
  await Deno.remove(root, { recursive: true });
});

Deno.test("claude-desktop-update: the switch keeps the previous version and prunes the rest", async () => {
  const root = await setup(["0.9.0", "1.0.0", "1.1.0"], "1.0.0");
  assertEquals((await run(root, ["--apply"])).code, 0);
  assertEquals(versions(root), ["1.0.0", "1.1.0"]);
  await Deno.remove(root, { recursive: true });
});

Deno.test("claude-desktop-update: the first switch works with no current version", async () => {
  const root = await setup(["2.0.0"], null);
  assertEquals((await run(root, ["--current"])).out, "");
  assertEquals((await run(root, ["--apply"])).code, 0);
  assertEquals(await current(root), "2.0.0");
  await Deno.remove(root, { recursive: true });
});

Deno.test("claude-desktop-update: rollback goes back one version, and refuses with nothing older", async () => {
  const root = await setup(["1.0.0", "1.1.0"], "1.1.0");
  assertEquals((await run(root, ["--rollback"], true)).code, 5);
  assertEquals((await run(root, ["--rollback"])).code, 0);
  assertEquals(await current(root), "1.0.0");
  // the version rolled back from stays: it is newer, and a later --apply would bring it back
  assertEquals(versions(root), ["1.0.0", "1.1.0"]);
  assertEquals((await log(root)).at(-1).event, "rollback");
  const lone = await setup(["1.0.0"], "1.0.0");
  const r = await run(lone, ["--rollback"]);
  assert(r.code === 1);
  await Deno.remove(root, { recursive: true });
  await Deno.remove(lone, { recursive: true });
});
