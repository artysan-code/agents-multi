// Tests for settings.ts: the merge patch algebra and adopting what Claude Code writes into a
// generated settings.json.
import { assertEquals } from "jsr:@std/assert@1";
import { adopt, buildSettings, diffPatch, manifestPatch, mergePatch, type Obj, paths, registryPatch, withoutRules } from "../settings.ts";

Deno.test("mergePatch: RFC 7386 — objects merge, null deletes, arrays and scalars replace", () => {
  assertEquals(mergePatch({ a: "b", c: { d: "e", f: "g" } }, { a: "z", c: { f: null } }), { a: "z", c: { d: "e" } });
  assertEquals(mergePatch({ a: [1, 2] }, { a: [3] }), { a: [3] });
  assertEquals(mergePatch({ a: { b: 1 } }, { a: 1 }), { a: 1 });
  assertEquals(mergePatch({ a: 1 }, { b: { c: null } }), { a: 1, b: {} });
  const base = { a: { b: 1 } };
  mergePatch(base, { a: { b: 2 } });
  assertEquals(base, { a: { b: 1 } }, "inputs are not mutated");
});

Deno.test("diffPatch: applying it turns from into to; key order is not a difference", () => {
  const cases: [Obj, Obj][] = [
    [{ a: 1, b: { c: 2, d: 3 }, e: [1] }, { a: 1, b: { c: 2 }, e: [1, 2], f: true }],
    [{ x: { y: { z: 1 } } }, {}],
    [{}, { x: { y: 1 } }],
    [{ a: { b: 1, c: 2 } }, { a: { c: 2, b: 1 } }],
  ];
  for (const [from, to] of cases) assertEquals(mergePatch(from, diffPatch(from, to)), to);
  assertEquals(diffPatch({ a: { b: 1, c: 2 }, d: 1 }, { d: 1, a: { c: 2, b: 1 } }), {});
});

const shared: Obj = { theme: "dark", enabledPlugins: { "ctx@m": true, "lsp@m": true, "mkt@synced": false } };

Deno.test("adopt: a plugin disabled in a session becomes that profile's false", () => {
  const built = buildSettings(shared, {}, {});
  const current = mergePatch(built, { enabledPlugins: { "ctx@m": false } }) as Obj;
  const r = adopt(shared, {}, built, current);
  assertEquals(r.changed, ["enabledPlugins.ctx@m"]);
  assertEquals(r.patch, { enabledPlugins: { "ctx@m": false } });
});

Deno.test("adopt: an uninstall that drops the key is kept as a deletion, so it is not auto-installed again", () => {
  const built = buildSettings(shared, {}, {});
  const current = structuredClone(built);
  delete (current.enabledPlugins as Obj)["lsp@m"];
  const r = adopt(shared, {}, built, current);
  assertEquals(r.patch, { enabledPlugins: { "lsp@m": null } });
  assertEquals((buildSettings(shared, r.patch, {}).enabledPlugins as Obj)["lsp@m"], undefined);
});

Deno.test("adopt: a shared change pulled since the last build survives the session's own write", () => {
  const built = buildSettings(shared, {}, {});
  const current = mergePatch(built, { theme: "light" }) as Obj;
  const newShared = mergePatch(shared, { model: "opus", enabledPlugins: { "new@m": true } }) as Obj;
  const r = adopt(newShared, {}, built, current);
  assertEquals(r.patch, { theme: "light" });
  const next = buildSettings(newShared, r.patch, {});
  assertEquals([next.model, next.theme, (next.enabledPlugins as Obj)["new@m"]], ["opus", "light", true]);
});

Deno.test("adopt: setting a value back to what shared says clears it from the patch", () => {
  const patch: Obj = { enabledPlugins: { "ctx@m": false }, theme: "light" };
  const built = buildSettings(shared, patch, {});
  const current = mergePatch(built, { enabledPlugins: { "ctx@m": true } }) as Obj;
  assertEquals(adopt(shared, patch, built, current).patch, { theme: "light" });
});

Deno.test("adopt: nothing written, nothing adopted — a reordered file included", () => {
  const built = buildSettings(shared, { theme: "light" }, {});
  const reordered = JSON.parse(JSON.stringify(built, Object.keys(built).reverse())) as Obj;
  const r = adopt(shared, { theme: "light" }, built, { ...reordered, enabledPlugins: built.enabledPlugins });
  assertEquals(r, { patch: { theme: "light" }, changed: [] });
});

Deno.test("manifestPatch: disableAccountMcp turns the connectors off and every synced plugin false", () => {
  assertEquals(manifestPatch({}, ["mkt@synced"]), {});
  assertEquals(manifestPatch({ disableAccountMcp: true }, ["a@synced", "b@synced"]), {
    disableClaudeAiConnectors: true,
    enabledPlugins: { "a@synced": false, "b@synced": false },
  });
  // the manifest wins over the profile patch
  const built = buildSettings(shared, { enabledPlugins: { "mkt@synced": true } }, manifestPatch({ disableAccountMcp: true }, ["mkt@synced"]));
  assertEquals((built.enabledPlugins as Obj)["mkt@synced"], false);
});

Deno.test("paths: dotted leaves, an emptied object counts as one", () => {
  assertEquals(paths({ a: { b: 1, c: { d: null } }, e: {} }), ["a.b", "a.c.d", "e"]);
});

Deno.test("registryPatch: the registry's rules join the lists the profile has, never replace them", () => {
  const base: Obj = { permissions: { deny: ["Bash(secret-tool:*)"], allow: ["Read"] } };
  const rules = { deny: ["mcp__n8n-ark__n8n_delete_workflow", "Bash(secret-tool:*)"], ask: ["mcp__n8n-ark__n8n_test_workflow"], hooks: [] };
  const built = buildSettings(base, {}, registryPatch(base, rules));
  assertEquals(built.permissions, {
    deny: ["Bash(secret-tool:*)", "mcp__n8n-ark__n8n_delete_workflow"],
    allow: ["Read"],
    ask: ["mcp__n8n-ark__n8n_test_workflow"],
  });
  assertEquals(registryPatch(base, { deny: [], ask: [], hooks: [] }), {});
  // a guard joins the PreToolUse hooks already there
  const guard = { matcher: "^(mcp__cf-a__execute)$", hooks: [{ type: "command" as const, command: "deno run g.ts" }] };
  const withHooks: Obj = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] }] } };
  assertEquals(buildSettings(withHooks, {}, registryPatch(withHooks, { deny: [], ask: [], hooks: [guard] })).hooks, {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] }, guard],
  });
});

Deno.test("withoutRules: an adopted list drops the generated rules, and what is left equal to shared goes too", () => {
  const shared: Obj = { permissions: { deny: ["A"] } };
  const guard = { matcher: "^(mcp__cf-a__execute)$", hooks: [{ type: "command" as const, command: "deno run g.ts" }] };
  const rules = { deny: ["mcp__x__del"], ask: [], hooks: [guard] };
  // Claude rewrote deny whole: adopting it would copy the generated rule into the repository
  assertEquals(withoutRules(shared, { permissions: { deny: ["A", "mcp__x__del"] } }, rules), {});
  assertEquals(withoutRules(shared, { permissions: { deny: ["A", "B", "mcp__x__del"] } }, rules), { permissions: { deny: ["A", "B"] } });
  assertEquals(withoutRules(shared, { model: "opus" }, rules), { model: "opus" });
  // Claude rewrote the hooks: the adopted list, minus the guard, is shared's again — nothing to keep
  const bash: Obj = { matcher: "Bash", hooks: [{ type: "command", command: "x.sh" }] };
  assertEquals(withoutRules({ hooks: { PreToolUse: [bash] } }, { hooks: { PreToolUse: [bash, guard as unknown as Obj] } }, rules), {});
});
