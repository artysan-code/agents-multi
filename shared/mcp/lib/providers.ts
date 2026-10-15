// providers.ts — what a provider is: Claude Code or Codex (OpenAI), each behind the one shape the hub, the
// CLI and a future scheduler use. A provider says
//   - how its process starts (`command`, `exec`): the hub's `startChild` writes the child's script around it.
//     Sending to a child, reading its state and stopping it are not the provider's: every child speaks the
//     same files (`in`, `out.jsonl`, `child.pid`, agents.ts), a Codex one through its driver;
//   - what it can do (`capabilities`), so a coordinator does not ask a Codex child a question it cannot;
//   - its accounts (`accounts`: derived from the profiles' manifests) and their usage windows (`limits`).

import { codexBin, codexHome, codexMcpOverrides, codexSandbox, MCP_TOKEN_VAR, readCodexLimits } from "./codex.ts";
import { claudeWindows, codexWindows, readLiveSnapshots, type Window } from "./limits.ts";
import { configDir } from "./owner.ts";
import type { ChildMode } from "./agents.ts";

export type ProviderName = "claude" | "codex";
export const PROVIDER_NAMES: readonly ProviderName[] = ["claude", "codex"];

/** What a provider's children can do. */
export interface Capabilities {
  /** a child's own question (`AskUserQuestion`) reaches the coordinator */
  nativeQuestions: boolean;
  /** a permission the profile's rules do not give comes back as a request to answer */
  permissionRequests: boolean;
  /** the child's result carries what the turn cost (`cost_usd`) */
  costReported: boolean;
}

/** A provider's account: one profile's login. Claude has one per profile; Codex one where the manifest
 *  says `"codex": true`. */
export interface Account {
  /** `<profile>/<provider>` */
  id: string;
  profile: string;
  provider: ProviderName;
}

/** Where things are, for what a provider reads: the person's configuration, the runtime and the state
 *  folder of the status line's snapshots. */
export interface Places {
  config: string;
  runtime: string;
  /** `<state>/live`: what the status line wrote */
  live: string;
}

/** The profiles a provider's accounts are derived from: name and whether it declares Codex. */
export interface ProfileInfo {
  name: string;
  codex: boolean;
}

export interface ExecInput {
  command: string;
  mode: ChildMode;
  model?: string;
  profile: string;
  runtime: string;
  mcpConfig?: string;
  allowedTools?: string[];
  /** rules it is denied whatever its mode (Claude only) */
  disallowedTools?: string[];
  /** rules it must ask for whatever its mode, so that the auto classifier cannot pass them (Claude only) */
  askTools?: string[];
  /** settings of its own for this session, such as a headless node's sandbox (headless.ts; Claude only) */
  settings?: Record<string, unknown>;
}

/** Pure: the session settings of a Claude child (`--settings`): its own, with the ask rules added to theirs. */
export function sessionSettings(i: Pick<ExecInput, "askTools" | "settings">): Record<string, unknown> | undefined {
  if (!i.askTools?.length && !i.settings) return undefined;
  const own = i.settings ?? {};
  const perms = (own.permissions ?? {}) as Record<string, unknown>;
  return i.askTools?.length
    ? { ...own, permissions: { ...perms, ask: [...((perms.ask as string[]) ?? []), ...i.askTools] } }
    : own;
}

export interface Provider {
  name: ProviderName;
  capabilities: Capabilities;
  /** the program, or why this profile cannot use the provider */
  command(profile: string, config: string, runtime: string): Promise<string>;
  /** the last line of the child's script (the `exec` that replaces the shell) and the variables that line
   *  reads (values never go in the text); a prelude of lines before it where it needs one */
  exec(
    i: ExecInput,
  ): Promise<{ line: string; env: Record<string, string> }> | { line: string; env: Record<string, string> };
  /** the accounts this provider has among the profiles */
  accounts(profiles: ProfileInfo[]): Account[];
  /** the account's usage windows that are still running, read the passive way (limits.ts) */
  limits(account: Account, at: Places, now?: number): Promise<Window[]>;
}

/** The launcher of a profile, from its manifest (`command`), else `claude-<profile>`. */
export async function launcherOf(profile: string, config = configDir()): Promise<string | null> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile)) return null;
  const m = await Deno.readTextFile(`${config}/profiles/${profile}/profile.json`).then(JSON.parse).catch(() => null);
  if (!m) return null;
  return (typeof m.command === "string" && m.command.trim()) || `claude-${profile}`;
}

const accountOf = (profile: string, provider: ProviderName): Account => ({
  id: `${profile}/${provider}`,
  profile,
  provider,
});

const claudeProvider: Provider = {
  name: "claude",
  capabilities: { nativeQuestions: true, permissionRequests: true, costReported: true },
  async command(profile, config) {
    const command = await launcherOf(profile, config);
    if (!command) throw new Error(`no profile ${profile}`);
    return command;
  },
  exec(i) {
    const env: Record<string, string> = { L: i.command, P: i.mode };
    if (i.model) env.M = i.model;
    if (i.mcpConfig) env.C = i.mcpConfig;
    if (i.allowedTools?.length) env.T = i.allowedTools.join(",");
    if (i.disallowedTools?.length) env.X = i.disallowedTools.join(",");
    const settings = sessionSettings(i);
    if (settings) env.S = JSON.stringify(settings);
    return {
      line: 'exec "$L" -p ${M:+--model "$M"} ${C:+--mcp-config "$C"} ${T:+--allowedTools "$T"} ' +
        '${X:+--disallowedTools "$X"} ${S:+--settings "$S"} ' +
        "--input-format stream-json --output-format stream-json --verbose " +
        '--permission-mode "$P" --permission-prompt-tool stdio < "$R/in" > "$R/out.jsonl" 2> "$R/err.log"',
      env,
    };
  },
  accounts: (profiles) => profiles.map((p) => accountOf(p.name, "claude")),
  async limits(account, at, now = Date.now() / 1000) {
    return claudeWindows(await readLiveSnapshots(at.live), account.profile, now);
  },
};

/** The gateway's token file of a profile, as bin/claude's launch config names it (apps/cli/mcp/
 *  gateway-settings.ts `tokenFileOf`). */
export const mcpTokenFile = (runtime: string, profile: string) => `${runtime}/${profile}/mcp-token`;

/** Codex: the profile declares an account (`"codex": true` in its manifest), whose `CODEX_HOME` is in the
 *  profile's runtime folder. Differences from Claude: no permission request ever reaches the owner (the
 *  sandbox is fixed by the profile's mode, `codexSandbox`), a message sent during a turn waits for the next
 *  one, no question, no cost. Its MCP servers are the profile's launch config (`<runtime>/<profile>/mcp.json`)
 *  given as `-c` overrides at each turn, the gateway's token read from its file into the driver's
 *  environment: a Codex step has no `team_send` (the workflow's team channel is Claude's flag). */
const codexProvider: Provider = {
  name: "codex",
  capabilities: { nativeQuestions: false, permissionRequests: false, costReported: false },
  async command(profile, config, runtime) {
    const m = await Deno.readTextFile(`${config}/profiles/${profile}/profile.json`).then(JSON.parse).catch(() => null);
    if (!m) throw new Error(`no profile ${profile}`);
    if (m.codex !== true) {
      throw new Error(`profile ${profile} has no Codex account: set "codex": true in its profile.json, then log in`);
    }
    const bin = codexBin(runtime);
    if (!(await Deno.stat(bin).catch(() => null))?.isFile) {
      throw new Error(`Codex is not installed: run \`agents update --codex\``);
    }
    // only whether a login is there, never what it holds
    if (!(await Deno.stat(`${codexHome(runtime, profile)}/auth.json`).catch(() => null))?.isFile) {
      throw new Error(`profile ${profile} has no Codex login: the owner runs \`agents codex ${profile} login\``);
    }
    return bin;
  },
  async exec(i) {
    const driver = new URL("../agents/codex-driver.ts", import.meta.url).pathname;
    const launch = await Deno.readTextFile(`${i.runtime}/${i.profile}/mcp.json`).then(JSON.parse).catch(() => null);
    const allowed = await Deno.readTextFile(`${i.runtime}/${i.profile}/mcp-codex.json`).then(JSON.parse).catch(() =>
      null
    );
    const mcp = codexMcpOverrides(launch?.mcpServers ?? {}, allowed?.tools ?? {});
    const env: Record<string, string> = {
      D: driver,
      CODEX_BIN: i.command,
      CODEX_HOME: codexHome(i.runtime, i.profile),
      CODEX_SANDBOX: codexSandbox(i.mode),
      CODEX_CONFIG: JSON.stringify(mcp.config),
    };
    if (i.model) env.CODEX_MODEL = i.model;
    if (mcp.token) env.TF = mcpTokenFile(i.runtime, i.profile);
    return {
      line: 'mkdir -p -m 700 "$CODEX_HOME"\n' +
        (mcp.token ? `IFS= read -r ${MCP_TOKEN_VAR} < "$TF" && export ${MCP_TOKEN_VAR}\nunset TF\n` : "") +
        'exec deno run --quiet --no-config --no-lock --allow-read="$R" --allow-write="$R" ' +
        '--allow-run="$CODEX_BIN" --allow-env=CODEX_BIN,CODEX_SANDBOX,CODEX_MODEL,CODEX_CONFIG "$D" "$R" > /dev/null 2>> "$R/err.log"',
      env,
    };
  },
  accounts: (profiles) => profiles.filter((p) => p.codex).map((p) => accountOf(p.name, "codex")),
  async limits(account, at, now = Date.now() / 1000) {
    return codexWindows(await readCodexLimits(codexHome(at.runtime, account.profile)), now);
  },
};

export const providers: Record<ProviderName, Provider> = { claude: claudeProvider, codex: codexProvider };

/** The profiles declared in the person's configuration (a profile.json in each folder of `<config>/profiles`), sorted. */
export async function profileInfos(config = configDir()): Promise<ProfileInfo[]> {
  const out: ProfileInfo[] = [];
  try {
    for await (const e of Deno.readDir(`${config}/profiles`)) {
      if (!e.isDirectory || !/^[a-z0-9][a-z0-9-]*$/.test(e.name)) continue;
      const m = await Deno.readTextFile(`${config}/profiles/${e.name}/profile.json`).then(JSON.parse).catch(() => null);
      if (m) out.push({ name: e.name, codex: m.codex === true });
    }
  } catch { /* no profiles folder */ }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Every account of every provider, by profile then provider. */
export async function listAccounts(config = configDir()): Promise<Account[]> {
  const profiles = await profileInfos(config);
  return PROVIDER_NAMES.flatMap((n) => providers[n].accounts(profiles)).sort((a, b) =>
    a.profile === b.profile ? a.provider.localeCompare(b.provider) : a.profile.localeCompare(b.profile)
  );
}

/** One account's usage windows. */
export const accountLimits = (account: Account, at: Places, now?: number) =>
  providers[account.provider].limits(account, at, now);

/** Every account with its windows (empty: no reading, the account has not run a turn lately). */
export async function allLimits(at: Places, now = Date.now() / 1000) {
  return await Promise.all(
    (await listAccounts(at.config)).map(async (account) => ({
      account,
      windows: await accountLimits(account, at, now),
    })),
  );
}

/** Where things are for a process that knows only the environment (the hub's MCP server): the home folder,
 *  `XDG_STATE_HOME` and `AGENTS_MULTI_CONFIG` are all it may read. */
export function placesFromEnv(): Places {
  const home = Deno.env.get("HOME") ?? "";
  const state = Deno.env.get("XDG_STATE_HOME") || `${home}/.local/state`;
  return { config: configDir(), runtime: `${home}/.agents-multi`, live: `${state}/agents-multi/live` };
}
