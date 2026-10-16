// node_scope_test.ts — a headless node talks to the brain with its node token only (ADR 0013, F2): never the vault's
// brain token, which is a machine's and reads the whole brain; the doctor's `node.scope` says when its token is wider.
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { brainTokenSource, cleanNodeConfig, machineHeadless } from "../../../shared/mcp/lib/headless.ts";
import { nodeFindings, tokenScope } from "../doctor/checks/node.ts";

Deno.test("brain token: a headless node uses its node token or nothing, never the vault's", () => {
  assertEquals(brainTokenSource(true, false, true), "node");
  assertEquals(brainTokenSource(true, true, true), "node");
  assertEquals(brainTokenSource(true, false, false), null);
  assertEquals(brainTokenSource(true, true, false), null);
  // a desktop is unchanged: the vault's, or its node token first where the caller asks
  assertEquals(brainTokenSource(false, false, true), "vault");
  assertEquals(brainTokenSource(false, false, false), "vault");
  assertEquals(brainTokenSource(false, true, true), "node");
  assertEquals(brainTokenSource(false, true, false), "vault");
});

Deno.test("brain token: headless is what this machine's file says; a file that cannot be read is an error", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await machineHeadless(`${dir}/none.json`), false);
    await Deno.writeTextFile(`${dir}/server.json`, JSON.stringify({ enabled: true, headless: true }));
    assertEquals(await machineHeadless(`${dir}/server.json`), true);
    await Deno.writeTextFile(`${dir}/desktop.json`, JSON.stringify({ enabled: true }));
    assertEquals(await machineHeadless(`${dir}/desktop.json`), false);
    await Deno.writeTextFile(`${dir}/junk.json`, "{");
    assertEquals(await machineHeadless(`${dir}/junk.json`), false);
    // a folder where the file should be: not readable, never taken for a desktop
    await Deno.mkdir(`${dir}/folder.json`);
    await assertRejects(() => machineHeadless(`${dir}/folder.json`), Error, "agents install");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor node.scope: refused by the scope is a node's, answered is wider, anything else unknown", () => {
  assertEquals(tokenScope(403, "this token's scope does not reach it"), "node");
  assertEquals(tokenScope(200), "wider");
  assertEquals(tokenScope(403, "cross-origin request refused"), "unknown");
  assertEquals(tokenScope(401), "unknown");
  assertEquals(tokenScope(502), "unknown");
  assertEquals(tokenScope(null), "unknown");
});

Deno.test("doctor node.scope: a server with a machine's token fails, with the fix; a node's passes", () => {
  const server = cleanNodeConfig({ enabled: true, headless: true });
  const base = {
    cfg: server,
    keyMode: null,
    exposed: [],
    service: "https://brain.x",
    approval: true,
    sandbox: null,
    tokenMode: 0o600,
  };
  const scope = (s: Parameters<typeof nodeFindings>[0]) => nodeFindings(s).filter((c) => c.id === "node.scope");
  const wide = scope({ ...base, scope: "wider" });
  assertEquals(wide.map((c) => c.status), ["fail"]);
  assertEquals(wide[0].fix?.includes("agents node pair --server"), true);
  assertEquals(wide[0].fix?.includes("https://brain.x/account"), true);
  assertEquals(scope({ ...base, scope: "node" }).map((c) => c.status), ["ok"]);
  assertEquals(scope({ ...base, scope: "unknown" }).map((c) => c.status), ["warn"]);
  // a headless machine not on yet is checked too; a desktop is never asked
  assertEquals(scope({ ...base, cfg: cleanNodeConfig({ headless: true }), scope: "wider" }).map((c) => c.status), [
    "fail",
  ]);
  assertEquals(scope({ ...base, cfg: cleanNodeConfig({ enabled: true }), scope: null }), []);
  // with no token, a server is told to pair as a server, never to sign in
  const none = nodeFindings({ ...base, tokenMode: null }).find((c) => c.id === "node.token");
  assertEquals(none?.fix, "agents node pair --server (the console takes the code)");
});
