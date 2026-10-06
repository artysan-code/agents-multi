// Every npm: and jsr: specifier in the code names the version deno.json's "imports" pins. The MCP
// servers keep full specifiers (Claude starts them from any directory, where no import map
// applies), so this test is what keeps one version per dependency across the repository.
import { assertEquals } from "jsr:@std/assert@1";

const ROOT = new URL("../../", import.meta.url).pathname;
const SKIP = /\/(node_modules|site|\.git|vendor)\//;

async function* sources(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}${e.name}`;
    if (SKIP.test(`${p}/`)) continue;
    if (e.isDirectory) yield* sources(`${p}/`);
    else if (e.name.endsWith(".ts")) yield p;
  }
}

Deno.test("deps: one version per dependency, the one deno.json pins", async () => {
  const pinned = JSON.parse(await Deno.readTextFile(`${ROOT}deno.json`)).imports as Record<string, string>;
  const want = new Map(Object.values(pinned).map((s) => [s.replace(/@[^@/]+$/, ""), s]));
  const wrong: string[] = [];
  for await (const file of sources(ROOT)) {
    const text = await Deno.readTextFile(file);
    for (const [, spec] of text.matchAll(/["']((?:npm|jsr):@?[^@"']+@[^/"']+)/g)) {
      const name = spec.replace(/@[^@/]+$/, "");
      if (want.get(name) !== spec) {
        wrong.push(`${file.slice(ROOT.length)}: ${spec} (deno.json: ${want.get(name) ?? "none"})`);
      }
    }
  }
  assertEquals(wrong, []);
});
