// codex.ts — Codex (OpenAI) as a provider beside Claude Code: where its CLI and a profile's account are,
// how a child's mode becomes its sandbox, what `codex exec --json` says in the words of Claude's
// stream-json (so the hub reads a Codex child's `out.jsonl` like any other), and the usage limits its
// session logs carry. Everything here is pure except `readCodexLimits`, which reads logs, never the login.

import type { ChildMode } from "./agents.ts";

/** The CLI's prefix: an `npm install --prefix` of the pinned `@openai/codex`, owned by Agents Multi
 *  (`agents update --codex`), never global and never needing root. */
export const codexPrefix = (runtime: string) => `${runtime}/providers/codex`;
export const codexBin = (runtime: string) => `${codexPrefix(runtime)}/node_modules/.bin/codex`;

/** A profile's Codex account: its `CODEX_HOME`, in the profile's runtime folder beside Claude's config. */
export const codexHome = (runtime: string, profile: string) => `${runtime}/${profile}/codex`;

/** Makes a Codex account's folder (private) when it is not there: `codex login` refuses a `CODEX_HOME`
 *  that does not exist. */
export async function ensureCodexHome(home: string): Promise<void> {
  await Deno.mkdir(home, { recursive: true, mode: 0o700 });
}

/** Pure: the sandbox a child's mode gives its commands. `codex exec` cannot ask the owner (it never
 *  waits on an approval), so where Claude would ask for a write, Codex gets no write: only a mode that
 *  lets Claude edit the project (`auto`, `acceptEdits`) gets `workspace-write` — the project's folder
 *  and temp, no network for the commands. Never `danger-full-access`. */
export const codexSandbox = (mode: ChildMode): "read-only" | "workspace-write" =>
  mode === "default" ? "read-only" : "workspace-write";

/** Pure: the arguments of one turn: the first (`exec`) or a follow-up (`exec resume <thread>`). */
export function codexArgs(
  i: { thread?: string; sandbox: string; model?: string; prompt: string; config?: string[] },
): string[] {
  const common = [
    "--json",
    "--skip-git-repo-check",
    "-c",
    `sandbox_mode="${i.sandbox}"`,
    "-c",
    'approval_policy="never"',
    ...(i.config ?? []).flatMap((c) => ["-c", c]),
    ...(i.model ? ["-m", i.model] : []),
  ];
  // the prompt goes last, after `--`: a task that starts with a dash is still a task
  return i.thread ? ["exec", "resume", ...common, i.thread, "--", i.prompt] : ["exec", ...common, "--", i.prompt];
}

/** The name of the environment variable a Codex child reads the gateway's token from. Its name has TOKEN
 *  in it on purpose: Codex keeps such variables out of the environment of the commands it runs. */
export const MCP_TOKEN_VAR = "AGENTS_MULTI_MCP_TOKEN";

/** The hub's own server: a Codex child never gets it (a child that starts children is the coordinator's
 *  to decide, not a default). */
const NOT_FOR_CHILDREN = new Set(["agents"]);

/** Pure: a profile's launch config (`<runtime>/<profile>/mcp.json`'s `mcpServers`, ADR 0006) as the `-c`
 *  overrides that give the same servers to Codex (which has no `--mcp-config`; its own are in
 *  `config.toml`, which nothing here writes). Servers behind the gateway (an http entry on 127.0.0.1) get
 *  the gateway's token from the environment variable `MCP_TOKEN_VAR`, never from a file or an argument;
 *  stdio servers keep their command, arguments and environment. An entry that needs more (an http server
 *  with its own header helper) or has a name TOML cannot take bare is left out. */
export function codexMcpOverrides(servers: Record<string, Record<string, unknown>>): {
  config: string[];
  token: boolean;
} {
  const config: string[] = [];
  let token = false;
  const t = (v: unknown) => JSON.stringify(v);
  for (const [name, cfg] of Object.entries(servers)) {
    if (NOT_FOR_CHILDREN.has(name) || !/^[A-Za-z0-9_-]+$/.test(name)) continue;
    const key = `mcp_servers.${name}`;
    if (typeof cfg.url === "string") {
      let host = "";
      try {
        host = new URL(cfg.url).hostname;
      } catch { /* not an address */ }
      if (host !== "127.0.0.1") continue;
      config.push(`${key}.url=${t(cfg.url)}`, `${key}.bearer_token_env_var=${t(MCP_TOKEN_VAR)}`);
      token = true;
    } else if (typeof cfg.command === "string") {
      config.push(`${key}.command=${t(cfg.command)}`);
      const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
      if (args.length) config.push(`${key}.args=${t(args)}`);
      for (const [k, v] of Object.entries((cfg.env ?? {}) as Record<string, unknown>)) {
        if (/^[A-Za-z0-9_]+$/.test(k)) config.push(`${key}.env.${k}=${t(String(v))}`);
      }
    }
  }
  return { config, token };
}

/** What a turn has told so far, to close it with the last thing said. */
export interface Turn {
  last: string;
}

/** Pure: one `codex exec --json` event as the lines it becomes in a child's `out.jsonl` (Claude's
 *  stream-json: init, assistant text, a tool use, result). Events that matter to nobody — reasoning,
 *  reconnection notices, the rest of the item kinds — become nothing; a turn that fails is a result
 *  with `is_error`. */
export function codexLines(e: Record<string, unknown>, turn: Turn): Record<string, unknown>[] {
  const item = (e.item ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "thread.started":
      return typeof e.thread_id === "string" ? [{ type: "system", subtype: "init", session_id: e.thread_id }] : [];
    case "item.completed":
      if (item.type === "agent_message" && typeof item.text === "string" && item.text.trim()) {
        turn.last = item.text.trim();
        return [{ type: "assistant", message: { content: [{ type: "text", text: turn.last }] } }];
      }
      return [];
    case "item.started":
      return item.type === "command_execution" && typeof item.command === "string"
        ? [{
          type: "assistant",
          message: { content: [{ type: "tool_use", name: "Bash", input: { command: item.command } }] },
        }]
        : [];
    case "turn.completed":
      return [{ type: "result", subtype: "success", is_error: false, result: turn.last }];
    case "turn.failed": {
      const msg = (e.error as { message?: unknown } | undefined)?.message;
      return [{
        type: "result",
        subtype: "error",
        is_error: true,
        result: typeof msg === "string" ? msg : "the turn failed",
      }];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------- usage limits

/** One window of an account's limits: `window` is its length in minutes (300 = 5 hours, 10080 = 7 days),
 *  `resets_at` when it resets, epoch seconds. */
export interface CodexWindow {
  window: number;
  used_percent: number;
  resets_at: number;
}

export interface CodexLimits {
  primary: CodexWindow | null;
  secondary: CodexWindow | null;
  plan: string | null;
  /** when the log line was written, ISO */
  at: string | null;
}

const windowOf = (w: unknown): CodexWindow | null => {
  const o = (w ?? {}) as Record<string, unknown>;
  return typeof o.window_minutes === "number" && typeof o.used_percent === "number" &&
      typeof o.resets_at === "number"
    ? { window: o.window_minutes, used_percent: o.used_percent, resets_at: o.resets_at }
    : null;
};

/** Pure: the latest `rate_limits` in a session log's lines (`event_msg` / `token_count`), or null. */
export function codexLimitsOf(lines: string[]): CodexLimits | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue;
    let e: { type?: string; timestamp?: string; payload?: { type?: string; rate_limits?: Record<string, unknown> } };
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const r = e.payload?.rate_limits;
    if (e.type !== "event_msg" || e.payload?.type !== "token_count" || !r) continue;
    const primary = windowOf(r.primary);
    const secondary = windowOf(r.secondary);
    if (!primary && !secondary) continue;
    return {
      primary,
      secondary,
      plan: typeof r.plan_type === "string" ? r.plan_type : null,
      at: typeof e.timestamp === "string" ? e.timestamp : null,
    };
  }
  return null;
}

/** The latest limits an account's session logs (`<home>/sessions/Y/M/D/rollout-*.jsonl`) carry: the
 *  newest logs first, until one has a reading. Reads no file but the logs. */
export async function readCodexLimits(home: string, scan = 5): Promise<CodexLimits | null> {
  const logs: string[] = [];
  const walk = async (dir: string, depth: number) => {
    const names: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) names.push(e.name);
    } catch {
      return;
    }
    // the folders and the files are named by date, so the order of the names is the order of time
    for (const n of names.sort().reverse()) {
      if (logs.length >= scan) return;
      if (depth < 3) await walk(`${dir}/${n}`, depth + 1);
      else if (/^rollout-.*\.jsonl$/.test(n)) logs.push(`${dir}/${n}`);
    }
  };
  await walk(`${home}/sessions`, 0);
  for (const f of logs) {
    const found = codexLimitsOf((await Deno.readTextFile(f).catch(() => "")).split("\n"));
    if (found) return found;
  }
  return null;
}
