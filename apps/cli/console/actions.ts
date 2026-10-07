// actions.ts — the CLI subcommands the console may run (POST /api/action, and the streamed jobs of
// jobs.ts): a fixed allowlist, each with the options it accepts and a timeout. An action may take one
// parameter, checked against values the server knows (never a free string). Output comes back as
// text, colours stripped.

import { REPO } from "../lib/paths.ts";
import { variantProfiles } from "../lib/profiles.ts";
import { log } from "../selfupdate.ts";

export interface ActionDef {
  args: string[];
  /** A script of bin/ to run instead of bin/claude-multi, with the parameter as its argument. */
  bin?: string;
  opts?: Record<string, string[]>;
  timeoutMs?: number;
  /** The one parameter the action takes, and where its allowed values come from. */
  param?: { name: string; allowed: () => Promise<string[]> };
}

/** Allowed actions to CLI arguments. `opts` accepted per action (anything else is ignored). */
export const ACTIONS: Record<string, ActionDef> = {
  "doctor": { args: ["doctor"] },
  "sync-fetch": { args: ["sync", "--fetch"], timeoutMs: 30000 },
  "mcp-check": { args: ["mcp", "check"] },
  "mcp-sync": { args: ["mcp", "sync"], opts: { force: ["--force"] } },
  "install-dry": { args: ["install", "--dry-run"] },
  "install": { args: ["install"] },
  "ui-build": { args: ["ui", "build"], timeoutMs: 300000 },
  "usage-ingest": { args: ["usage", "ingest", "--full"], timeoutMs: 120000 },
  "update-check": { args: ["update", "--check"], timeoutMs: 40000 },
  "update-now": { args: ["update", "--auto"], timeoutMs: 900000 },
  // the install a round left waiting for Claude to be closed (the sessions are closed by close-claude.ts)
  "settle-install": { args: ["self-update", "--settle"], timeoutMs: 300000 },
  "rollback-cli": { args: ["update", "--rollback"] },
  "rollback-desktop": { args: ["update", "--rollback", "--desktop"], timeoutMs: 180000 },
  // one variant's Desktop build, for a profile that has one of its own
  "desktop-rebuild": {
    args: [],
    bin: "claude-desktop-rebuild",
    timeoutMs: 600000,
    param: { name: "profile", allowed: variantProfiles },
  },
};

export type Params = Record<string, string>;
export type Resolved = { cmd: string; args: string[] } | { error: string };

/** The command line of an allowed action. An unknown name, a parameter the action does not take, or
 *  a value outside what the server knows is an error and nothing is run. */
export async function resolveAction(
  name: string,
  opts: string[] = [],
  params: Params = {},
  defs: Record<string, ActionDef> = ACTIONS,
): Promise<Resolved> {
  const a = Object.hasOwn(defs, name) ? defs[name] : undefined;
  if (!a) return { error: `unknown action: ${name}` };
  if (Object.keys(params).some((k) => k !== a.param?.name)) return { error: `${name}: unknown parameter` };
  const extra = opts.flatMap((o) => a.opts?.[o] ?? []);
  if (!a.param) return { cmd: `${REPO}/bin/${a.bin ?? "agents-multi"}`, args: [...a.args, ...extra] };
  const v = params[a.param.name];
  if (typeof v !== "string" || !(await a.param.allowed()).includes(v)) {
    return { error: `${name}: ${a.param.name} is not one this machine knows` };
  }
  return { cmd: `${REPO}/bin/${a.bin ?? "agents-multi"}`, args: [...a.args, v, ...extra] };
}

/** The action as a command to type, for «run manually». */
export function manualCommand(name: string, params: Params = {}, defs: Record<string, ActionDef> = ACTIONS): string {
  const a = defs[name];
  return [a.bin ?? "agents-multi", ...a.args, ...Object.values(params)].join(" ");
}

/** What an action leaves behind when it succeeds: a variant rebuilt by hand is entered in the update
 *  log, so the doctor stops reporting the failure that asked for it. */
export async function afterAction(name: string, params: Params, code: number) {
  if (code === 0 && name === "desktop-rebuild") await log("rebuilt", "", "", params.profile, "desktop");
}

// deno-lint-ignore no-control-regex
export const stripColours = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Runs an allowed action; a refused one answers code 2 without running. */
export async function runAction(name: string, opts: string[], params: Params = {}) {
  const r = await resolveAction(name, opts, params);
  if ("error" in r) return { code: 2, output: r.error, ms: 0 };
  const t0 = Date.now();
  const child = new Deno.Command(r.cmd, {
    args: r.args,
    cwd: REPO,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  }, ACTIONS[name].timeoutMs ?? 60000);
  const out = await child.output();
  clearTimeout(timer);
  const dec = new TextDecoder();
  let output = stripColours(dec.decode(out.stdout));
  const err = stripColours(dec.decode(out.stderr)).trim();
  if (err) output += (output ? "\n" : "") + err;
  // update --check exits 10 when an update exists: not an error (the check writes its own cache)
  const code = name === "update-check" && out.code === 10 ? 0 : out.code;
  await afterAction(name, params, code);
  return { code, output, ms: Date.now() - t0 };
}
