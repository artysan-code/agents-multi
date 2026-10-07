// Tests for apps/cli/projects.ts: a task's project resolved to one of Alice's folders.
import { assertEquals } from "jsr:@std/assert@1";
import { type ProjectNode, resolveProject } from "../projects.ts";

const node = (path: string, repo = false): ProjectNode => ({
  path,
  name: path.split("/").pop()!,
  depth: path.split("/").length - 1,
  repo,
});
const tree = [
  node("work"),
  node("work/acme"),
  node("work/acme/portal"),
  node("work/clients"),
  node("work/clients/acme"),
  node("personal"),
  node("personal/dnd/dragons-lair", true),
];

Deno.test("resolveProject: a path as it is, a name to the shallowest folder, anything else to nothing", () => {
  assertEquals(resolveProject("work/acme/portal", tree), "work/acme/portal");
  assertEquals(resolveProject("~/work/acme/portal/", tree), "work/acme/portal");
  assertEquals(resolveProject("PORTAL", tree), "work/acme/portal");
  assertEquals(resolveProject("acme", tree), "work/acme"); // not work/clients/acme
  assertEquals(resolveProject("dragons-lair", tree), "personal/dnd/dragons-lair");
  assertEquals(resolveProject("agents-multi", tree), null);
  assertEquals(resolveProject(undefined, tree), null);
});
