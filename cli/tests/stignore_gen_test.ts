// stignore-gen (shared/tools/stignore-gen): the generated section, checked against the Syncthing semantics
// of shared/mcp/syncthing-status/ignore.ts.
import { assertEquals } from "jsr:@std/assert@1";
import { compilePattern, isIgnored } from "../../shared/mcp/syncthing-status/ignore.ts";
import { handManaged, MARK_BEGIN, MARK_END, plan, render, repoBlock, split } from "../../shared/tools/stignore-gen/stignore-gen.ts";

const compile = (text: string) => text.split("\n").map(compilePattern).filter((c) => c !== null);

Deno.test("stignore-gen: a repository block lets only the files git ignores on purpose travel", () => {
  const c = compile(["**/.git", ...repoBlock("acme/app")].join("\n"));
  for (const f of [".env", ".env.local", "apps/web/.env.local", "supabase/functions/.env", ".claude/settings.local.json"]) {
    assertEquals(isIgnored(`acme/app/${f}`, c), false, f);
  }
  for (const f of [".git/HEAD", "src/main.ts", ".env.example", "apps/web/.env.example", ".claude/settings.json", ".claude/worktrees/x/.env"]) {
    assertEquals(isIgnored(`acme/app/${f}`, c), true, f);
  }
  assertEquals(isIgnored("acme/notes.md", c), false);
});

Deno.test("stignore-gen: exceptions written above the markers match first", () => {
  const manual = "!/bithub/CLAUDE.md\n/site/.env\n";
  const c = compile(render(manual, ["bithub", "site"]));
  assertEquals(isIgnored("bithub/CLAUDE.md", c), false);
  assertEquals(isIgnored("bithub/lesson.md", c), true);
  assertEquals(isIgnored("site/.env", c), true); // tracked by git: kept out despite the block's re-include
  assertEquals(isIgnored("site/.env.local", c), false);
});

Deno.test("stignore-gen: the section only grows unless pruned", () => {
  const text = render("// rules\n", ["a/one", "b/two"]);
  assertEquals(plan(text, ["b/two", "c/three"], false), { repos: ["a/one", "b/two", "c/three"], added: ["c/three"] });
  assertEquals(plan(text, ["b/two"], true), { repos: ["b/two"], added: [] });
});

Deno.test("stignore-gen: a repository excluded by hand is not generated", () => {
  assertEquals([...handManaged("/5etools/mcp\n(?d)/x/y/*\n!/z/.env\n// /w\n/v/**")].sort(), ["5etools/mcp", "v", "x/y"]);
  assertEquals(plan("/5etools/mcp\n", ["5etools/mcp", "app"], false).repos, ["app"]);
});

Deno.test("stignore-gen: rendering is idempotent and keeps the text around the markers", () => {
  const first = render("// head\n/x\n", ["r"]);
  assertEquals(render(first, ["r"]), first);
  const middle = `// head\n${MARK_BEGIN}\n${MARK_END}\n// tail\n`;
  const out = render(middle, ["r"]);
  assertEquals(split(out).before, "// head\n");
  assertEquals(split(out).after, "\n// tail\n");
});
