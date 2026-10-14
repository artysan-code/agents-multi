// backend.ts — one stdio MCP server run for the gateway, and what is asked of it: its tool list
// (kept in the cache) and its calls. The same code lets `agents mcp warm` fill the cache without the gateway.

import { Client } from "npm:@modelcontextprotocol/sdk@1.32.1/client/index.js";
import { StdioClientTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/client/stdio.js";
import type { BackendSpec } from "./core.ts";

/** A call the person's work can run for a long time (a deploy, a test run): the SDK's own 60 s is too short. */
export const CALL_TIMEOUT_MS = 10 * 60_000;
const START_TIMEOUT_MS = 60_000;

export interface Running {
  client: Client;
  pid: number | null;
  /** resolves when the process is gone, whoever ended it */
  gone: Promise<void>;
  close(): Promise<void>;
}

/** The variables of a Claude session (and of the profile it runs as: CLAUDE_CONFIG_DIR): what a gateway
 *  started from a terminal inside one must not hand to the backends of every other profile. Same set as
 *  `claudeSessionVars` in shared/mcp/lib/agents.ts. */
const SESSION_VARS =
  /^(CLAUDECODE|CLAUDE_CONFIG_DIR|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PROJECT_DIR|CLAUDE_ENV_FILE|CLAUDE_(CODE|AGENT_SDK|PREVIEW)_.*)$/;

/** Pure: the environment a backend gets — the gateway's own without any session's variables, then the
 *  entry's (which carries AGENTS_MULTI_PROFILE and the account's settings: the profile is the entry's, never
 *  inherited). */
export function backendEnv(base: Record<string, string>, spec: BackendSpec): Record<string, string> {
  const own = Object.fromEntries(Object.entries(base).filter(([k]) => !SESSION_VARS.test(k)));
  return { ...own, ...spec.env };
}

/** Starts the server and completes the MCP handshake. @throws when it does not come up. */
export async function startBackend(
  spec: BackendSpec,
  base: Record<string, string>,
  onStderr?: (line: string) => void,
): Promise<Running> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: backendEnv(base, spec),
    cwd: base.HOME || undefined,
    stderr: "pipe",
  });
  transport.stderr?.on("data", (b: Uint8Array) => {
    for (const l of new TextDecoder().decode(b).split("\n")) if (l.trim()) onStderr?.(l);
  });
  let done!: () => void;
  const gone = new Promise<void>((r) => done = r);
  transport.onclose = () => done();
  const client = new Client({ name: "agents-gateway", version: "1" });
  await client.connect(transport, { timeout: START_TIMEOUT_MS });
  return {
    client,
    pid: transport.pid,
    gone,
    close: async () => {
      await client.close().catch(() => {});
      done();
    },
  };
}

/** The tools of a running server (every page of them) and the instructions it gave at initialize. */
export async function describe(client: Client): Promise<{ tools: unknown[]; instructions?: string }> {
  const tools: unknown[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return { tools, instructions: client.getInstructions() };
}
