// Tests for Codex as a provider (shared/mcp/lib/codex.ts, agents/codex-driver.ts): its events in Claude's
// stream, its arguments and sandbox, the usage limits in a session log (a synthetic one), and a whole
// round with a stand-in for `codex` started through the hub.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { readChild, sayTo, startChild, stopChild } from "../../../shared/mcp/lib/agents.ts";
import {
  codexArgs,
  codexBin,
  codexHome,
  codexLimitsOf,
  codexLines,
  codexMcpOverrides,
  codexSandbox,
  ensureCodexHome,
  readCodexLimits,
  type Turn,
} from "../../../shared/mcp/lib/codex.ts";
import { REPO } from "../lib/paths.ts";

Deno.test("codex: a turn's events become Claude's stream", () => {
  const t: Turn = { last: "" };
  const run = (e: Record<string, unknown>) => codexLines(e, t);
  assertEquals(run({ type: "thread.started", thread_id: "abc" }), [{
    type: "system",
    subtype: "init",
    session_id: "abc",
  }]);
  assertEquals(run({ type: "turn.started" }), []);
  assertEquals(run({ type: "error", message: "Reconnecting... 2/5" }), []);
  assertEquals(run({ type: "item.completed", item: { type: "reasoning", text: "hm" } }), []);
  assertEquals(run({ type: "item.started", item: { type: "command_execution", command: "ls -la" } }), [{
    type: "assistant",
    message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls -la" } }] },
  }]);
  assertEquals(run({ type: "item.completed", item: { type: "agent_message", text: " done " } }), [{
    type: "assistant",
    message: { content: [{ type: "text", text: "done" }] },
  }]);
  assertEquals(run({ type: "turn.completed" }), [{
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
  }]);
  assertEquals(run({ type: "turn.failed", error: { message: "boom" } })[0].is_error, true);
});

Deno.test("codex: arguments and sandbox", () => {
  assertEquals(codexSandbox("default"), "read-only");
  assertEquals([codexSandbox("auto"), codexSandbox("acceptEdits")], ["workspace-write", "workspace-write"]);
  const first = codexArgs({ sandbox: "read-only", model: "gpt-5", prompt: "--rm -rf" });
  assertEquals(first.slice(0, 2), ["exec", "--json"]);
  assertEquals(first.slice(-2), ["--", "--rm -rf"]);
  assert(first.includes('sandbox_mode="read-only"') && first.includes('approval_policy="never"'));
  assert(!first.join(" ").includes("danger"));
  const next = codexArgs({ thread: "t-1", sandbox: "workspace-write", prompt: "more" });
  assertEquals(next.slice(0, 2), ["exec", "resume"]);
  assertEquals(next.slice(-3), ["t-1", "--", "more"]);
  assertEquals(codexHome("/rt", "work"), "/rt/work/codex");
  assertEquals(codexBin("/rt"), "/rt/providers/codex/node_modules/.bin/codex");
});

// a synthetic session log: made-up numbers, in the shape of Codex's rollout files
const tc = (ts: string, primary: number, secondary: number) =>
  JSON.stringify({
    timestamp: ts,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: "codex",
        primary: { used_percent: primary, window_minutes: 300, resets_at: 1800000000 },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 1800500000 },
        credits: null,
        plan_type: "plus",
      },
    },
  });

Deno.test("codex: the latest limits in a session log", async () => {
  const lines = [
    tc("2030-01-01T10:00:00Z", 10, 3),
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }),
    tc("2030-01-01T11:00:00Z", 42.5, 4),
    "not json",
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: null } }),
  ];
  assertEquals(codexLimitsOf(lines), {
    primary: { window: 300, used_percent: 42.5, resets_at: 1800000000 },
    secondary: { window: 10080, used_percent: 4, resets_at: 1800500000 },
    plan: "plus",
    at: "2030-01-01T11:00:00Z",
  });
  assertEquals(codexLimitsOf(["", "{}"]), null);

  // from a CODEX_HOME: the newest log with a reading wins
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/sessions/2030/01/01`, { recursive: true });
    await Deno.mkdir(`${home}/sessions/2030/01/02`, { recursive: true });
    await Deno.writeTextFile(`${home}/sessions/2030/01/01/rollout-a.jsonl`, tc("2030-01-01T11:00:00Z", 20, 2) + "\n");
    await Deno.writeTextFile(`${home}/sessions/2030/01/02/rollout-b.jsonl`, '{"type":"session_meta"}\n');
    assertEquals((await readCodexLimits(home))?.primary?.used_percent, 20);
    await Deno.writeTextFile(`${home}/sessions/2030/01/02/rollout-c.jsonl`, tc("2030-01-02T09:00:00Z", 61, 5) + "\n");
    assertEquals((await readCodexLimits(home))?.primary?.used_percent, 61);
    assertEquals(await readCodexLimits(`${home}/nowhere`), null);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("codex: a whole round through the hub, with a stand-in for codex", async () => {
  const home = await Deno.makeTempDir();
  try {
    const runs = `${home}/runs`,
      config = `${home}/config`,
      work = `${home}/work/proj`,
      runtime = `${home}/.agents-multi`;
    await Deno.mkdir(`${config}/profiles/cx`, { recursive: true });
    await Deno.mkdir(`${config}/profiles/plain`, { recursive: true });
    await Deno.mkdir(work, { recursive: true });
    await Deno.writeTextFile(`${config}/profiles/cx/profile.json`, JSON.stringify({ codex: true }));
    await Deno.writeTextFile(`${config}/profiles/plain/profile.json`, "{}");
    const start = () =>
      startChild({ profile: "cx", provider: "codex", dir: work, task: "list files" }, runs, home, config, runtime);
    // no account declared, no Codex installed, no login: each refuses, saying what to do
    await assertRejects(
      () => startChild({ profile: "plain", provider: "codex", dir: work, task: "x" }, runs, home, config, runtime),
      Error,
      "no Codex account",
    );
    await assertRejects(start, Error, "agents update --codex");
    const bin = codexBin(runtime);
    await Deno.mkdir(bin.slice(0, bin.lastIndexOf("/")), { recursive: true });
    await Deno.copyFile(`${REPO}/apps/cli/tests/fixtures/fake-codex.sh`, bin);
    await Deno.chmod(bin, 0o755);
    await assertRejects(start, Error, "agents codex cx login");
    await Deno.mkdir(codexHome(runtime, "cx"), { recursive: true });
    await Deno.writeTextFile(`${codexHome(runtime, "cx")}/auth.json`, "{}"); // only its presence is looked at
    // the profile's launch config and the gateway's token (a made-up one): what a Codex child is given
    await Deno.writeTextFile(
      `${runtime}/cx/mcp.json`,
      JSON.stringify({
        mcpServers: {
          brain: { type: "http", url: "http://127.0.0.1:7332/cx/brain", headersHelper: "bash x" },
          writer: { type: "http", url: "http://127.0.0.1:7332/cx/writer" },
          agents: { type: "stdio", command: "deno", args: ["hub"] },
        },
      }),
    );
    await Deno.writeTextFile(`${runtime}/cx/mcp-codex.json`, JSON.stringify({ tools: { brain: ["tasks_list"] } }));
    await Deno.writeTextFile(`${runtime}/cx/mcp-token`, "fake-token\n");

    const meta = await start();
    assertEquals([meta.provider, meta.command, meta.mode], ["codex", bin, "default"]);
    const until = async (ok: (turns: number) => boolean) => {
      for (let t = 0; t < 200; t++) {
        const c = await readChild(meta.id, runs);
        if (c && ok(c.state.turns) && c.state.phase === "idle") return c.state;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`stuck: ${JSON.stringify((await readChild(meta.id, runs))?.state)}`);
    };
    const first = await until((n) => n === 1);
    assertEquals([first.session, first.lastResult, first.error], [
      "0192aaaa-bbbb-cccc-dddd-000000000001",
      "did: list files",
      null,
    ]);
    await sayTo(meta.id, "and again", runs);
    const second = await until((n) => n === 2);
    assertEquals(second.lastResult, "resumed: and again");
    assertEquals(second.said.at(-1), "resumed: and again");

    const calls = (await Deno.readTextFile(`${work}/calls.txt`)).trim().split("\n");
    assertEquals(calls.length, 2);
    assert(calls.every((c) => c.startsWith(`${codexHome(runtime, "cx")}|`)), "CODEX_HOME is the profile's");
    assert(calls[0].includes('sandbox_mode="read-only"') && calls[1].includes("exec resume"));
    for (const c of calls) {
      assert(c.includes('-c mcp_servers.brain.url="http://127.0.0.1:7332/cx/brain"'), "the gateway entry");
      assert(c.includes('bearer_token_env_var="AGENTS_MULTI_MCP_TOKEN"'), "the token's variable, not its value");
      assert(c.includes('mcp_servers.brain.enabled_tools=["tasks_list"]'), "only the allowed tools");
      assert(
        !c.includes("mcp_servers.agents") && !c.includes("mcp_servers.writer"),
        "never the hub, nor a server with no allowed tool",
      );
      assert(c.endsWith("|token=fake-token"), "the token reaches Codex through its environment only");
    }
    assert(!(await Deno.readTextFile(`${runs}/${meta.id}/meta.json`)).includes("fake-token"));

    await stopChild(meta.id, false, runs);
    for (let t = 0; t < 100 && (await readChild(meta.id, runs))?.state.phase !== "ended"; t++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals((await readChild(meta.id, runs))?.state.phase, "ended");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("codex: a profile's launch config as -c overrides: allowed tools only, the token only by variable", () => {
  const servers = {
    brain: { type: "http", url: "http://127.0.0.1:7332/p/brain", headersHelper: "bash h t" },
    remote: { type: "http", url: "https://example.com/mcp", headersHelper: "bash other" },
    "n8n-x": { type: "stdio", command: "node", args: ["a.js", "--x"], env: { K: "v" } },
    writer: { type: "stdio", command: "w" },
    agents: { type: "stdio", command: "deno", args: ["hub"] },
    "bad name": { command: "x" },
  };
  const tools = { brain: ["a", "b"], remote: ["r"], "n8n-x": ["get"], agents: ["agent_start"], "bad name": ["x"] };
  const { config, token } = codexMcpOverrides(servers, tools);
  assertEquals(config, [
    'mcp_servers.brain.url="http://127.0.0.1:7332/p/brain"',
    'mcp_servers.brain.bearer_token_env_var="AGENTS_MULTI_MCP_TOKEN"',
    'mcp_servers.brain.enabled_tools=["a","b"]',
    'mcp_servers.brain.default_tools_approval_mode="approve"',
    'mcp_servers.n8n-x.command="node"',
    'mcp_servers.n8n-x.enabled_tools=["get"]',
    'mcp_servers.n8n-x.default_tools_approval_mode="approve"',
    'mcp_servers.n8n-x.args=["a.js","--x"]',
    'mcp_servers.n8n-x.env.K="v"',
  ]);
  assert(token);
  assertEquals(codexMcpOverrides({ n: { command: "x" } }, { n: ["t"] }).token, false);
  assertEquals(codexMcpOverrides(servers, {}), { config: [], token: false });
  assertEquals(
    codexArgs({ sandbox: "read-only", prompt: "p", config: ["a.b=1"] }).slice(-6, -2),
    ["-c", 'approval_policy="never"', "-c", "a.b=1"],
  );
});

Deno.test("codex: the account's folder is made, private, and left alone when there", async () => {
  const root = await Deno.makeTempDir();
  try {
    const home = codexHome(root, "cx");
    await ensureCodexHome(home);
    assertEquals((await Deno.stat(home)).mode! & 0o777, 0o700);
    await Deno.writeTextFile(`${home}/auth.json`, "{}");
    await ensureCodexHome(home);
    assert((await Deno.stat(`${home}/auth.json`)).isFile);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
