// Tests for cm_code (bin/lib/profiles.sh): what ~/.local/bin/claude is pointed at after a Claude Code
// update. In app mode the app's copy, never the folder the script runs from (an AppImage's mount).
import { assertEquals } from "jsr:@std/assert@1";
import { REPO } from "../lib/paths.ts";

async function cmCode(root: string) {
  const r = await new Deno.Command("bash", {
    args: ["-c", `source "${REPO}/bin/lib/profiles.sh"; cm_code`],
    env: { AGENTS_MULTI_ROOT: root },
    stdout: "piped",
  }).output();
  return new TextDecoder().decode(r.stdout).trim();
}

Deno.test("cm_code: the app's copy in app mode, the checkout in dev mode", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/app/current/shared`, { recursive: true });
    await Deno.symlink("app/current/shared", `${root}/shared`);
    assertEquals(await cmCode(root), `${root}/app/current`);
    await Deno.remove(`${root}/shared`);
    await Deno.symlink(`${REPO}/shared`, `${root}/shared`);
    assertEquals(await cmCode(root), REPO);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
