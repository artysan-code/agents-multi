// toolrun.ts — `claude-multi vault run <service> [account] -- <tool> …`: a command-line tool of a
// service (wrangler for Cloudflare) run with the account's token from the vault in its environment,
// so the token is the same one the MCP server uses and never sits in a file, an argument or a
// login of the tool's own.
//
// Only the service's own tool runs, resolved from the project's node_modules/.bin (or PATH): a
// session cannot hand the token to `env` or a script of its own. The tool's output goes through a
// filter that hides the token if it ever shows up. What deletes or rewrites remote data asks for a
// typed "yes" on a terminal, which a Claude session does not have: there, it is refused and the
// person runs it themselves. Like the guard on the MCP's execute, this stops mistakes, not code
// written to slip past it; the token's scope stays the hard boundary.

import { HIDDEN } from "../shared/mcp/lib/mask.ts";

const dirname = (p: string) => p.replace(/\/+[^/]*\/*$/, "") || "/";
const join = (...parts: string[]) => parts.join("/").replace(/\/{2,}/g, "/");

export interface Runner {
  /** the executable, as the person types it */
  tool: string;
  /** the variable the tool reads the token from */
  env: string;
  /** Pure but for reading a file the command names: why this command needs a person, or null. */
  destructive: (args: string[], read: (path: string) => string | null) => string | null;
  /** subcommands that would keep a credential outside the vault */
  refused: string[];
}

const DESTRUCTIVE_SQL = /\b(drop|delete|truncate|alter)\b/i;

/** Pure: what makes a wrangler command one a person runs, or null. */
export function wranglerDestructive(args: string[], read: (path: string) => string | null): string | null {
  const words = args.filter((a) => !a.startsWith("-"));
  const [cmd, sub, third] = words;
  if (cmd === "delete") return "it deletes a Worker";
  if (cmd === "rollback" || (cmd === "versions" && sub === "rollback") || (cmd === "deployments" && sub === "rollback")) return "it rolls a Worker back";
  // `kv key delete`, `kv namespace delete`, `kv bulk delete`, `r2 bucket delete`, `r2 object delete`,
  // `d1 delete`, `queues delete`, `secret delete`, `pages project delete`…
  if (words.slice(0, 3).includes("delete")) return `it deletes (${words.slice(0, 3).join(" ")})`;
  if (cmd === "d1" && (sub === "execute" || sub === "migrations") && args.includes("--remote")) {
    if (sub === "migrations" && third === "apply") return "it applies migrations to the remote database";
    const at = (flag: string) => {
      const i = args.findIndex((a) => a === flag || a.startsWith(`${flag}=`));
      if (i < 0) return null;
      return args[i].includes("=") ? args[i].slice(flag.length + 1) : args[i + 1] ?? null;
    };
    const sql = at("--command") ?? (at("--file") ? read(at("--file")!) ?? "" : "");
    if (DESTRUCTIVE_SQL.test(sql)) return "it runs DROP, DELETE, TRUNCATE or ALTER on the remote database";
  }
  return null;
}

export const RUNNERS: Record<string, Runner> = {
  cloudflare: { tool: "wrangler", env: "CLOUDFLARE_API_TOKEN", destructive: wranglerDestructive, refused: ["login", "logout"] },
};

/** Pure: the profile a command runs in — the one a server is given, else the Claude configuration
 *  directory it was started from (~/.claude-multi/<profile>), which a shell and a session both have. */
export function profileFrom(env: { profile?: string; configDir?: string }, runtime: string): string | undefined {
  if (env.profile) return env.profile;
  const dir = env.configDir?.replace(/\/+$/, "");
  return dir && dirname(dir) === runtime.replace(/\/+$/, "") ? dir.split("/").pop() : undefined;
}

export interface RunPlan {
  service: string;
  account?: string;
  runner: Runner;
  args: string[];
}

/** Pure: `<service> [account] -- <tool> args…` read, or an error that says what is wrong. */
export function parseRun(argv: string[]): RunPlan {
  const dash = argv.indexOf("--");
  const head = dash < 0 ? [] : argv.slice(0, dash), cmd = dash < 0 ? [] : argv.slice(dash + 1);
  const [service, account, ...extra] = head;
  const usage = `usage: claude-multi vault run <service> [account] -- <tool> [args…]   (services: ${Object.keys(RUNNERS).join(", ")})`;
  if (!service || extra.length || !cmd.length) throw new Error(usage);
  const runner = RUNNERS[service];
  if (!runner) throw new Error(`no command-line tool for ${service}: ${Object.keys(RUNNERS).map((s) => `${s} → ${RUNNERS[s].tool}`).join(", ")}`);
  if (cmd[0] !== runner.tool) throw new Error(`with ${service} the token goes only to ${runner.tool}: … -- ${runner.tool} ${cmd.slice(1).join(" ")}`.trim());
  const args = cmd.slice(1);
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub && runner.refused.includes(sub)) throw new Error(`${runner.tool} ${sub}: not here, the token comes from the vault (claude-multi vault run)`);
  return { service, ...(account ? { account } : {}), runner, args };
}

/** The tool's executable: the project's own (node_modules/.bin, from here up), else on PATH. */
export async function findTool(tool: string, from = Deno.cwd()): Promise<string | null> {
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, "node_modules", ".bin", tool);
    if (await Deno.stat(p).then((s) => s.isFile, () => false)) return p;
    if (dirname(dir) === dir) break;
  }
  for (const dir of (Deno.env.get("PATH") ?? "").split(":").filter(Boolean)) {
    const p = join(dir, tool);
    if (await Deno.stat(p).then((s) => s.isFile, () => false)) return p;
  }
  return null;
}

/** A stream with every occurrence of `secret` replaced, even when it is split across chunks. */
export function hiding(secret: string): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder(), dec = new TextDecoder();
  let held = "";
  const keep = Math.max(secret.length - 1, 0);
  return new TransformStream({
    transform(chunk, ctl) {
      const text = (held + dec.decode(chunk, { stream: true })).replaceAll(secret, HIDDEN);
      // the tail could be the start of the secret: held back until the next chunk
      held = text.slice(Math.max(text.length - keep, 0));
      const out = text.slice(0, text.length - held.length);
      if (out) ctl.enqueue(enc.encode(out));
    },
    flush(ctl) {
      const rest = (held + dec.decode()).replaceAll(secret, HIDDEN);
      if (rest) ctl.enqueue(enc.encode(rest));
    },
  });
}

/** Asks for a typed "yes" on the terminal; false without one. */
function confirm(why: string, line: string): boolean {
  if (!Deno.stdin.isTerminal()) return false;
  const answer = prompt(`${line}\n${why}. Type yes to run it:`);
  return answer?.trim().toLowerCase() === "yes";
}

/** Runs the plan with the token in the environment; the tool's exit code. */
export async function runTool(plan: RunPlan, secret: string): Promise<number> {
  const { runner, args } = plan;
  const line = `${runner.tool} ${args.join(" ")}`;
  const why = runner.destructive(args, (p) => { try { return Deno.readTextFileSync(p); } catch { return null; } });
  if (why && !confirm(why, line)) {
    console.error(`refused: ${line} — ${why}. Run it yourself from a terminal: claude-multi vault run ${plan.service}${plan.account ? ` ${plan.account}` : ""} -- ${line}`);
    return 3;
  }
  const exe = await findTool(runner.tool);
  if (!exe) {
    console.error(`${runner.tool} is not installed: add it to the project (pnpm add -D ${runner.tool}), then run this again`);
    return 127;
  }
  const child = new Deno.Command(exe, {
    args, env: { [runner.env]: secret }, stdin: "inherit", stdout: "piped", stderr: "piped",
  }).spawn();
  const forward = (sig: Deno.Signal) => () => { try { child.kill(sig); } catch { /* already gone */ } };
  const handlers = (["SIGINT", "SIGTERM"] as Deno.Signal[]).map((s) => [s, forward(s)] as const);
  for (const [s, h] of handlers) Deno.addSignalListener(s, h);
  try {
    await Promise.all([
      child.stdout.pipeThrough(hiding(secret)).pipeTo(Deno.stdout.writable, { preventClose: true }),
      child.stderr.pipeThrough(hiding(secret)).pipeTo(Deno.stderr.writable, { preventClose: true }),
    ]);
    return (await child.status).code;
  } finally {
    for (const [s, h] of handlers) Deno.removeSignalListener(s, h);
  }
}
