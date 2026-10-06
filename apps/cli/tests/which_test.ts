// Tests for which()/has() in apps/cli/lib.ts: a PATH lookup with no shell, so a name taken from a
// configuration file is looked up, never run.
import { assertEquals } from "jsr:@std/assert@1";
import { which } from "../lib/proc.ts";

Deno.test("which: PATH order, absolute paths, executables only, metacharacters looked up literally", async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${a}/tool`, "#!/bin/sh\n");
    await Deno.chmod(`${a}/tool`, 0o644); // not executable: skipped
    await Deno.writeTextFile(`${b}/tool`, "#!/bin/sh\n");
    await Deno.chmod(`${b}/tool`, 0o755);
    assertEquals(await which("tool", `${a}:${b}`), `${b}/tool`);
    assertEquals(await which(`${b}/tool`, ""), `${b}/tool`);
    assertEquals(await which(`${a}/tool`, ""), null);
    assertEquals(await which("tool; touch /tmp/pwned", `${a}:${b}`), null);
    assertEquals(await which("missing", `${a}:${b}`), null);
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});
