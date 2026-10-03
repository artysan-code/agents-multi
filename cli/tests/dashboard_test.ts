// Tests for the console page: its scripts share one global scope (AGENTS.md), so a top-level name
// declared twice silently replaces the other one — Sistema › Salute once drew the Brain's health.
import { assertEquals } from "jsr:@std/assert@1";

Deno.test("dashboard scripts: no top-level name declared in two of them", async () => {
  const dir = new URL("../dashboard/", import.meta.url);
  const seen = new Map<string, string>(), twice: string[] = [];
  for (const f of ["i18n.js", "app.js", "brain.js", "tasks.js"]) {
    const src = await Deno.readTextFile(new URL(f, dir));
    for (const m of src.matchAll(/^(?:async\s+)?(?:function\s+([\w$]+)|(?:const|let|var|class)\s+([\w$]+))/gm)) {
      const name = m[1] ?? m[2];
      if (seen.has(name) && seen.get(name) !== f) twice.push(`${name} (${seen.get(name)}, ${f})`);
      else seen.set(name, f);
    }
  }
  assertEquals(twice, []);
});
