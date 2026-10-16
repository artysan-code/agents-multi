// node_brain_test.ts — the brain's tools for a headless node's children (ADR 0013, F2): the brain MCP server signed in
// with the node's own token through a headers helper (never the vault's, never in a configuration or an environment),
// the files a child's commands cannot read, the doctor's node.brain, and what a refused call says.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1";
import { servers } from "../mcp/placement.ts";
import type { LaunchPaths, Registry } from "../mcp/registry.ts";
import { type NodeFacts, nodeFindings } from "../doctor/checks/node.ts";
import { brainView, childSettings, listedTools, NODE_ONLY } from "../../../shared/mcp/lib/headless.ts";
import { refusal } from "../../../shared/mcp/lib/brain-tasks.ts";
import { cleanNodeConfig } from "../../../shared/mcp/lib/headless.ts";

const LAUNCH_TS = fromFileUrl(new URL("../../../shared/mcp/lib/launch.ts", import.meta.url));

function registry(node?: string[], paths?: LaunchPaths): Registry {
  return {
    profiles: ["work"],
    servers: { brain: { type: "http", url: "{url}/mcp", _service: "brain" } },
    accounts: [{ service: "brain", name: "brain", url: "https://brain.example" }],
    launch: paths ?? {
      script: "/rt/shared/mcp/lib/launch.ts",
      shim: "/rt/shared/mcp/lib/launch.sh",
      read: ["/v"],
      hooks: "/rt/shared/hooks",
      deno: "deno",
    },
    ...(node ? { node: { files: node } } : {}),
  };
}

const brainCfg = (r: Registry) => servers(r, { profile: "work", surface: "cli" }).find((p) => p.entry === "brain")!.cfg;

Deno.test("node brain: a desktop's brain server signs in by itself (/mcp), unchanged", () => {
  assertEquals(brainCfg(registry()), { type: "http", url: "https://brain.example/mcp" });
});

Deno.test("node brain: on a headless node the brain server gets a headers helper, the token in no file", () => {
  const cfg = brainCfg(registry(["/s/node.json", "/s/node-token"]));
  assertEquals(cfg.url, "https://brain.example/mcp");
  const h = String(cfg.headersHelper);
  assert(h.startsWith("AGENTS_MULTI_PROFILE=work deno run"), h);
  assertStringIncludes(h, "/rt/shared/mcp/lib/launch.ts headers brain brain 'Authorization=Bearer {secret}'");
  // it reads the node's files, and the variables that move them
  assertStringIncludes(h, "--allow-read=/v,/s/node.json,/s/node-token");
  assertStringIncludes(h, "XDG_STATE_HOME,AGENTS_MULTI_NODE_TOKEN_FILE");
  // Desktop's config holds commands only: the http brain never goes there
  assertEquals(servers(registry(["/s/node.json"]), { profile: "work", surface: "desktop" }).length, 0);
});

/** A headless machine in a folder of its own: its node.json, its token (optional), an accounts.json. */
async function machine(token: string | null) {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/state/agents-multi`, { recursive: true });
  await Deno.writeTextFile(`${dir}/state/agents-multi/node.json`, JSON.stringify({ enabled: true, headless: true }));
  if (token) await Deno.writeTextFile(`${dir}/state/agents-multi/node-token`, token + "\n");
  await Deno.writeTextFile(
    `${dir}/accounts.json`,
    JSON.stringify({ accounts: [{ service: "brain", name: "brain", url: "https://brain.example" }] }),
  );
  return dir;
}

/** The helper the registry places, run as Claude Code runs it: through a shell, with this machine's variables. */
async function runHelper(dir: string) {
  const paths: LaunchPaths = {
    script: LAUNCH_TS,
    shim: "/nonexistent",
    read: [dir, fromFileUrl(new URL("../../../shared", import.meta.url))],
    hooks: "/nonexistent",
    deno: Deno.execPath(),
  };
  const files = [`${dir}/state/agents-multi/node.json`, `${dir}/state/agents-multi/node-token`];
  const helper = String(brainCfg(registry(files, paths)).headersHelper);
  const out = await new Deno.Command("sh", {
    args: ["-c", helper],
    env: {
      XDG_STATE_HOME: `${dir}/state`,
      AGENTS_MULTI_ACCOUNTS: `${dir}/accounts.json`,
      // a vault that is not there: the helper must not need one
      AGENTS_MULTI_VAULT: `${dir}/no-vault`,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { ok: out.success, out: dec.decode(out.stdout), err: dec.decode(out.stderr) };
}

Deno.test("node brain: the helper prints the node's own token as the header, with no vault at all", async () => {
  const dir = await machine("brain_node_tok");
  try {
    const r = await runHelper(dir);
    assert(r.ok, r.err);
    assertEquals(JSON.parse(r.out), { Authorization: "Bearer brain_node_tok" });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("node brain: with no node token the helper refuses, and never falls back on the vault", async () => {
  const dir = await machine(null);
  try {
    const r = await runHelper(dir);
    assert(!r.ok);
    assertStringIncludes(r.err, NODE_ONLY);
    assertEquals(r.out, "");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("node brain: a child's commands cannot read the node's state or token, wherever they are", async () => {
  const dir = await Deno.makeTempDir();
  const prev = Deno.env.get("AGENTS_MULTI_NODE_TOKEN_FILE");
  try {
    const state = `${dir}/xdg/agents-multi`;
    await Deno.mkdir(state, { recursive: true });
    await Deno.writeTextFile(`${state}/node.json`, JSON.stringify({ enabled: true, headless: true }));
    Deno.env.set("AGENTS_MULTI_NODE_TOKEN_FILE", `${dir}/elsewhere/tok`);
    const s = await childSettings("/home/n", "/home/n/.agents-multi", dir, `${state}/node.json`) as {
      sandbox: { filesystem: { denyRead: string[] } };
      permissions: { deny: string[] };
    };
    const deny = s.sandbox.filesystem.denyRead;
    assert(deny.includes(state), "the state folder, under XDG_STATE_HOME");
    assert(deny.includes(`${dir}/elsewhere/tok`), "the token file, where the variable puts it");
    assert(deny.includes("/home/n/.local/state/agents-multi"), "the default state folder still");
    assertEquals(deny.length, new Set(deny).size);
    assert(s.permissions.deny.includes(`Read(/${dir}/elsewhere/tok)`));
  } finally {
    if (prev === undefined) Deno.env.delete("AGENTS_MULTI_NODE_TOKEN_FILE");
    else Deno.env.set("AGENTS_MULTI_NODE_TOKEN_FILE", prev);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("node brain: the view from the listed tools, as JSON or as an SSE event", () => {
  assertEquals(brainView(["brain_read", "brain_search", "tasks_list"]), "node");
  assertEquals(brainView(["brain_read", "brain_write"]), "whole");
  assertEquals(brainView(["tasks_list"]), "none");
  const tools = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "brain_read" }, { name: "tasks_list" }] } };
  assertEquals(listedTools(JSON.stringify(tools)), ["brain_read", "tasks_list"]);
  assertEquals(listedTools(`event: message\ndata: ${JSON.stringify(tools)}\n\n`), ["brain_read", "tasks_list"]);
  assertEquals(listedTools("<html>"), []);
});

Deno.test("node brain: the doctor's node.brain", () => {
  const base: NodeFacts = {
    cfg: cleanNodeConfig({ headless: true }),
    keyMode: null,
    exposed: [],
    service: "https://brain.example",
    approval: true,
    sandbox: null,
  };
  const of = (brain: NodeFacts["brain"]) => nodeFindings({ ...base, brain }).find((c) => c.id === "node.brain");
  assertEquals(of({ view: "node", profile: "work" })?.status, "ok");
  assertEquals(of({ view: "whole", profile: "work" })?.status, "fail");
  assertEquals(of({ view: "none", profile: "work" })?.status, "warn");
  const e = of({ view: "error", profile: "work", error: "the brain answered 401" });
  assertEquals(e?.status, "warn");
  assertStringIncludes(e!.msg, "401");
  assertEquals(of({ view: "absent" })?.status, "ok");
  assertEquals(of(null), undefined, "a desktop: no such check");
});

Deno.test("node brain: what the tasks server says when the brain refuses", () => {
  assertStringIncludes(refusal(401, "/api/tasks"), "agents node pair --server");
  assertStringIncludes(refusal(401, "/api/tasks"), "agents brain-login");
  assertStringIncludes(
    refusal(403, "/api/tasks/x", "this token's scope does not reach it"),
    "a server node's token",
  );
  assertEquals(refusal(500, "/api/tasks"), "the brain answered 500 on /api/tasks");
  assertEquals(refusal(403, "/api/x", "cross-origin"), "the brain answered 403 on /api/x: cross-origin");
});
