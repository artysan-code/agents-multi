#!/usr/bin/env -S deno run --allow-read --allow-env --allow-run
// launch.ts — how a server that is not ours gets one account's secret without it ever being
// written into a configuration file.
//
// `agents mcp sync` expands a registry entry with `_perAccount` into one server per account
// (apps/cli/mcp/placement.ts). Everything about the account but its secret is already in that server's config:
// the address, the name. The secret stays a `{secret}` placeholder, and this script fills it in when
// the server starts, reading the vault (vault.ts) like our own servers do:
//
//   launch.ts env <service> <account> [--env NAME=template]… [--bind key=template]… -- <command> [args…]
//       a stdio server: resolves the variables and the arguments the project's binding adds, prints
//       them as NUL-ended records on stdout (envRecords) and exits. It never starts <command>: that is
//       launch.sh, which reads the records, exports the variables and `exec`s the command, so no
//       wrapper stays alive between Claude and the server (a Deno process cannot exec).
//       --bind ties the server to what a project chose for it: the nearest .claude/claude-multi.json
//       from the folder Claude started in, upwards, holds { "<service>": { "<key>": value } }; each
//       key set there adds its template as an argument, {value} filled in (true adds it as it is,
//       false or missing adds nothing). No file, or no section for this service: the server starts
//       as it always has.
//   launch.ts headers <service> <account> [NAME=template]…
//       an http server's `headersHelper`: prints the headers as one JSON object, which Claude Code
//       reads on every connection. The output is the secret: it goes to Claude Code, nowhere else.
//
// The account must be one the profile sees (AGENTS_MULTI_PROFILE, accounts.json): a configuration
// edited by hand cannot reach an account the registry keeps from that profile.

import { loadAccounts, resolveAccount, visibleAccounts } from "./accounts.ts";
import { getSecret } from "./vault.ts";
import { machineHeadless, NODE_ONLY } from "./headless.ts";
import { amEnv } from "./env.ts";

interface LaunchArgs {
  mode: "env" | "headers";
  service: string;
  account: string;
  /** name → template, `{secret}` still in it */
  vars: Record<string, string>;
  /** a key of the project's binding → the argument it adds, `{value}` still in it */
  binds: Record<string, string>;
  command?: string;
  args: string[];
}

/** Pure: the command line, or an error that says what is wrong with it. */
export function parseLaunchArgs(argv: string[]): LaunchArgs {
  const [mode, service, account, ...rest] = argv;
  if (mode !== "env" && mode !== "headers") throw new Error(`usage: launch.ts env|headers <service> <account> …`);
  if (!service || !account) throw new Error("launch.ts: service and account are required");
  const vars: Record<string, string> = {}, binds: Record<string, string> = {};
  const pair = (into: Record<string, string>) => (s: string) => {
    const i = s.indexOf("=");
    if (i < 1) throw new Error(`launch.ts: expected NAME=value, got "${s}"`);
    into[s.slice(0, i)] = s.slice(i + 1);
  };
  if (mode === "headers") {
    rest.forEach(pair(vars));
    return { mode, service, account, vars, binds, args: [] };
  }
  let i = 0;
  for (; i < rest.length && rest[i] !== "--"; i++) {
    if ((rest[i] !== "--env" && rest[i] !== "--bind") || i + 1 >= rest.length) {
      throw new Error(`launch.ts: unexpected "${rest[i]}" before --`);
    }
    const isEnv = rest[i] === "--env";
    pair(isEnv ? vars : binds)(rest[++i]);
    const name = rest[i].slice(0, rest[i].indexOf("="));
    if (isEnv && !/^[A-Za-z_]\w*$/.test(name)) throw new Error(`launch.ts: "${name}" is not a variable name`);
  }
  const [command, ...args] = rest.slice(i + 1);
  if (!command) throw new Error("launch.ts env: the command goes after --");
  return { mode, service, account, vars, binds, command, args };
}

/** Pure: the templates with the secret in place. */
export function fill(vars: Record<string, string>, secret: string): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.replaceAll("{secret}", secret)]));
}

/** Pure: what `env` prints for launch.sh — one NUL-ended record per variable (`E` NAME=value) and per
 *  argument the binding adds (`A` arg). NUL cannot be in a value, so no quoting and nothing to eval. */
export function envRecords(vars: Record<string, string>, extra: string[]): string {
  return [...Object.entries(vars).map(([k, v]) => `E${k}=${v}`), ...extra.map((a) => `A${a}`)]
    .map((r) => `${r}\0`).join("");
}

/** Where a project keeps what it chose for agents-multi's servers, under its folder. Never committed:
 *  `agents install` puts it in git's global ignore. */
export const BINDING_FILE = ".claude/claude-multi.json";

/** Pure: the arguments a project's binding adds for one service. A value is a plain word (letters,
 *  digits, - _ .): it ends up on a command line. */
export function bindArgs(binding: unknown, service: string, binds: Record<string, string>): string[] {
  const mine = (binding as Record<string, unknown> | null)?.[service];
  if (!mine || typeof mine !== "object") return [];
  const out: string[] = [];
  for (const [key, tpl] of Object.entries(binds)) {
    const v = (mine as Record<string, unknown>)[key];
    if (v === undefined || v === null || v === false) continue;
    if (v === true) {
      out.push(tpl);
      continue;
    }
    if (typeof v !== "string" || !/^[\w.-]+$/.test(v)) {
      throw new Error(`${BINDING_FILE}: ${service}.${key} must be a plain word, or true/false`);
    }
    out.push(tpl.replaceAll("{value}", v));
  }
  return out;
}

/** Pure: the folders a binding is looked for in, nearest first: from `dir` up to `home`, nothing
 *  outside it (projects live in the home folder, and that is all the launcher may read). */
export function bindingDirs(dir: string, home: string): string[] {
  const top = home.replace(/\/+$/, "");
  if (dir !== top && !dir.startsWith(`${top}/`)) return [];
  const out: string[] = [];
  for (let d = dir.replace(/\/+$/, ""); d.length >= top.length; d = d.slice(0, d.lastIndexOf("/"))) out.push(d);
  return out;
}

/** The nearest binding file from `dir` up to the home folder: where it is and what it says, or null. */
export function findBinding(dir: string, home: string): { path: string; binding: unknown } | null {
  for (const d of bindingDirs(dir, home)) {
    const p = `${d}/${BINDING_FILE}`;
    let text: string;
    try {
      text = Deno.readTextFileSync(p);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    try {
      return { path: p, binding: JSON.parse(text) };
    } catch {
      throw new Error(`${p}: not valid JSON`);
    }
  }
  return null;
}

const needsSecret = (vars: Record<string, string>) => Object.values(vars).some((v) => v.includes("{secret}"));

async function main() {
  const a = parseLaunchArgs(Deno.args);
  const visible = visibleAccounts(loadAccounts(), a.service, amEnv("PROFILE") || undefined);
  const account = resolveAccount(visible, a.account, a.service);
  let vars = a.vars;
  if (needsSecret(vars)) {
    // the vault's brain token is a machine's: never on a server (ADR 0013, F2)
    if (a.service === "brain" && await machineHeadless()) throw new Error(NODE_ONLY);
    const secret = await getSecret(a.service, account.name);
    if (!secret) {
      throw new Error(
        `no secret for ${a.service}/${account.name} on this machine: console › Connections, or agents vault set ${a.service} ${account.name}`,
      );
    }
    vars = fill(vars, secret);
  }
  if (a.mode === "headers") {
    console.log(JSON.stringify(vars));
    return;
  }
  let extra: string[] = [];
  if (Object.keys(a.binds).length) {
    const found = findBinding(Deno.cwd(), Deno.env.get("HOME") ?? "/nonexistent");
    extra = found ? bindArgs(found.binding, a.service, a.binds) : [];
    // stderr is the server's log in the client: what it is tied to, or that it is not
    console.error(
      extra.length
        ? `${a.service}-${account.name}: ${extra.join(" ")} (${found!.path})`
        : `${a.service}-${account.name}: not bound to a project (no "${a.service}" in a ${BINDING_FILE} from ${Deno.cwd()} up)`,
    );
  }
  const out = new TextEncoder().encode(envRecords(vars, extra));
  for (let n = 0; n < out.length;) n += Deno.stdout.writeSync(out.subarray(n));
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
