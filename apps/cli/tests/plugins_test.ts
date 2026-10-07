// Tests for plugins.ts: reading the CLI's output, the table the console shows, and the command
// confirmation that must never be accepted on the person's behalf.
import { assertEquals } from "jsr:@std/assert@1";
import { ID_RE, NAME_RE, parseJson, pendingCommand, plugTable, sourceArg, validSource } from "../plugins.ts";

Deno.test("parseJson: whole output, else the last line after a notice, else null", () => {
  assertEquals(parseJson('[{"id":"a@m"}]'), [{ id: "a@m" }]);
  assertEquals(parseJson('Cloning…\n{"outcome":"ok"}'), { outcome: "ok" });
  assertEquals(parseJson("✔ done"), null);
});

Deno.test("plugTable: shared, a profile's override, what is built and what is installed", () => {
  const rows = plugTable(["a", "b"], { enabledPlugins: { "x@m": true, "old@synced": false } }, {
    a: {
      patch: { enabledPlugins: { "x@m": false } },
      built: { enabledPlugins: { "x@m": false, "old@synced": false } },
      installed: [{ id: "x@m", version: "1" }],
    },
    b: {
      patch: { enabledPlugins: { "only-b@m": true } },
      built: { enabledPlugins: { "x@m": true, "only-b@m": true } },
      installed: [{ id: "only-b@m" }],
    },
  });
  assertEquals(rows.map((r) => r.id), ["old@synced", "only-b@m", "x@m"]);
  const x = rows.find((r) => r.id === "x@m")!;
  assertEquals([x.shared, x.synced, x.name, x.marketplace], [true, false, "x", "m"]);
  assertEquals(x.profiles.a, { override: false, enabled: false, installed: true, version: "1" });
  assertEquals(x.profiles.b, { override: undefined, enabled: true, installed: false, version: undefined });
  const onlyB = rows.find((r) => r.id === "only-b@m")!;
  assertEquals([onlyB.shared, onlyB.profiles.a.enabled, onlyB.profiles.b.override], [undefined, false, true]);
  assertEquals(rows.find((r) => r.id === "old@synced")!.synced, true);
});

Deno.test("pendingCommand: only an unaccepted marketplace command asks for confirmation", () => {
  assertEquals(pendingCommand({ outcome: "ok", shownCommand: { command: "x", sha256: "s" } }), undefined);
  assertEquals(
    pendingCommand({ outcome: "needs-confirmation", shownCommand: { command: "npx build", sha256: "abc" } }),
    { command: "npx build", sha256: "abc" },
  );
  assertEquals(pendingCommand({ outcome: "refused", shownCommand: { argv: ["sh", "-c", "make"], sha256: "d" } }), {
    command: "sh -c make",
    sha256: "d",
  });
  assertEquals(pendingCommand({ outcome: "error", message: "boom" }), undefined);
  assertEquals(pendingCommand(null), undefined);
});

Deno.test("sourceArg: a declared marketplace source as `marketplace add` takes it", () => {
  assertEquals(sourceArg({ source: "github", repo: "anthropics/claude-code" }), "anthropics/claude-code");
  assertEquals(sourceArg({ source: "git", url: "https://example.com/m.git" }), "https://example.com/m.git");
  assertEquals(sourceArg({ source: "directory", path: "/srv/m" }), "/srv/m");
  assertEquals(sourceArg({ source: "github" }), null);
  assertEquals(sourceArg("nope"), null);
});

Deno.test("argument injection: nothing that reaches the CLI can start with a dash", () => {
  for (const id of ["-x@m", "x@-m", "--scope@m", "x@m --yes", "@m", "x@"]) assertEquals(ID_RE.test(id), false, id);
  assertEquals(ID_RE.test("code-review@claude-plugins-official"), true);
  for (const n of ["-x", "--claudeai", ""]) assertEquals(NAME_RE.test(n), false, n);
  for (const s of ["--claudeai", "-x", "a b", ""]) assertEquals(validSource(s), false, s);
  for (const s of ["anthropics/claude-code", "https://example.com/m.git", "/srv/m"]) {
    assertEquals(validSource(s), true, s);
  }
});

Deno.test("catalogPage: filters by marketplace and words, then slices; the total is of the filtered list", async () => {
  const { catalogPage } = await import("../plugins.ts");
  const e = (id: string, marketplace: string, description = "") => ({
    id,
    name: id,
    marketplace,
    description,
    installs: 0,
  });
  const all = [e("a@m1", "m1", "git helper"), e("b@m2", "m2", "GIT tools"), e("c@m1", "m1", "docs"), e("d@m1", "m1")];
  assertEquals(catalogPage(all, { limit: 2 }).entries.map((c) => c.id), ["a@m1", "b@m2"]);
  assertEquals(catalogPage(all, { limit: 2 }).total, 4);
  assertEquals(catalogPage(all, { offset: 2, limit: 5 }).entries.map((c) => c.id), ["c@m1", "d@m1"]);
  const git = catalogPage(all, { q: " Git " });
  assertEquals([git.total, git.entries.map((c) => c.id)], [2, ["a@m1", "b@m2"]]);
  assertEquals(catalogPage(all, { q: "git", mk: "m2" }).entries.map((c) => c.id), ["b@m2"]);
  assertEquals(catalogPage(all, { offset: -3, limit: 0 }).offset, 0);
});
