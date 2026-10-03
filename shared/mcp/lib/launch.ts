#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run
// launch.ts — how a server that is not ours gets one account's secret without it ever being
// written into a configuration file.
//
// `claude-multi mcp sync` expands a registry entry with `_perAccount` into one server per account
// (cli/mcp.ts). Everything about the account but its secret is already in that server's config:
// the address, the name. The secret stays a `{secret}` placeholder, and this script fills it in when
// the server starts, reading the vault (vault.ts) like our own servers do:
//
//   launch.ts run <service> <account> [--env NAME=template]… -- <command> [args…]
//       a stdio server: starts <command> with those variables set, and stands between it and the
//       client only as a pipe (stdio inherited, signals forwarded, its exit code returned).
//   launch.ts headers <service> <account> [NAME=template]…
//       an http server's `headersHelper`: prints the headers as one JSON object, which Claude Code
//       reads on every connection. The output is the secret: it goes to Claude Code, nowhere else.
//
// The account must be one the profile sees (CLAUDE_MULTI_PROFILE, accounts.json): a configuration
// edited by hand cannot reach an account the registry keeps from that profile.

import { loadAccounts, resolveAccount, visibleAccounts } from "./accounts.ts";
import { getSecret } from "./vault.ts";

export interface LaunchArgs {
  mode: "run" | "headers";
  service: string;
  account: string;
  /** name → template, `{secret}` still in it */
  vars: Record<string, string>;
  command?: string;
  args: string[];
}

/** Pure: the command line, or an error that says what is wrong with it. */
export function parseLaunchArgs(argv: string[]): LaunchArgs {
  const [mode, service, account, ...rest] = argv;
  if (mode !== "run" && mode !== "headers") throw new Error(`usage: launch.ts run|headers <service> <account> …`);
  if (!service || !account) throw new Error("launch.ts: service and account are required");
  const vars: Record<string, string> = {};
  const pair = (s: string) => {
    const i = s.indexOf("=");
    if (i < 1) throw new Error(`launch.ts: expected NAME=value, got "${s}"`);
    vars[s.slice(0, i)] = s.slice(i + 1);
  };
  if (mode === "headers") {
    rest.forEach(pair);
    return { mode, service, account, vars, args: [] };
  }
  let i = 0;
  for (; i < rest.length && rest[i] !== "--"; i++) {
    if (rest[i] !== "--env" || i + 1 >= rest.length) throw new Error(`launch.ts: unexpected "${rest[i]}" before --`);
    pair(rest[++i]);
  }
  const [command, ...args] = rest.slice(i + 1);
  if (!command) throw new Error("launch.ts run: the command goes after --");
  return { mode, service, account, vars, command, args };
}

/** Pure: the templates with the secret in place. */
export function fill(vars: Record<string, string>, secret: string): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.replaceAll("{secret}", secret)]));
}

const needsSecret = (vars: Record<string, string>) => Object.values(vars).some((v) => v.includes("{secret}"));

async function main() {
  const a = parseLaunchArgs(Deno.args);
  const visible = visibleAccounts(loadAccounts(), a.service, Deno.env.get("CLAUDE_MULTI_PROFILE") || undefined);
  const account = resolveAccount(visible, a.account, a.service);
  let vars = a.vars;
  if (needsSecret(vars)) {
    const secret = await getSecret(a.service, account.name);
    if (!secret) throw new Error(`no secret for ${a.service}/${account.name} on this machine: console › Connections, or claude-multi vault set ${a.service} ${account.name}`);
    vars = fill(vars, secret);
  }
  if (a.mode === "headers") {
    console.log(JSON.stringify(vars));
    return;
  }
  const child = new Deno.Command(a.command!, { args: a.args, env: vars, stdin: "inherit", stdout: "inherit", stderr: "inherit" }).spawn();
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    Deno.addSignalListener(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  }
  Deno.exit((await child.status).code);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    // stderr is where an MCP client looks when a server will not start
    console.error((e as Error).message);
    Deno.exit(1);
  }
}
