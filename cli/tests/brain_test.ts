// Tests for brain.ts: reading the wiki's frontmatter and links, and naming what lands in _raw/.
import { assertEquals } from "jsr:@std/assert@1";
import { frontmatter, resolveLink, wikilinks } from "../brain.ts";

Deno.test("frontmatter: scalars, quoted values and inline lists; the body after it", () => {
  const { data, body } = frontmatter(`---\ntitle: "claude-multi — visione"\ncategory: projects\ntags: [setup, meta, 'claude']\nsummary: una riga\n---\n\n# Titolo\n`);
  assertEquals(data, { title: "claude-multi — visione", category: "projects", tags: ["setup", "meta", "claude"], summary: "una riga" });
  assertEquals(body, "\n# Titolo\n");
  assertEquals(frontmatter("no frontmatter").data, {});
});

Deno.test("wikilinks: plain, labelled, with a heading, .md tolerated", () => {
  assertEquals(
    wikilinks("see [[projects/ark/ark]], [[index|the index]] and [[references/claude-update-gate#Pezzi]] or [[hot.md]]"),
    ["projects/ark/ark", "index", "references/claude-update-gate", "hot"],
  );
});

Deno.test("resolveLink: full path, unique bare name, ambiguous or unknown → nothing", () => {
  const paths = ["projects/ark/ark", "projects/claude-multi/claude-multi", "index", "a/readme", "b/readme"];
  const byName = new Map<string, string[]>();
  for (const p of paths) byName.set(p.split("/").pop()!, [...(byName.get(p.split("/").pop()!) ?? []), p]);
  assertEquals(resolveLink("projects/ark/ark", paths, byName), "projects/ark/ark");
  assertEquals(resolveLink("claude-multi", paths, byName), "projects/claude-multi/claude-multi");
  assertEquals(resolveLink("readme", paths, byName), null);
  assertEquals(resolveLink("nowhere", paths, byName), null);
});
