// actions.ts — the CLI subcommands the console may run (POST /api/action): a fixed allowlist, each
// with the options it accepts and a timeout. Output comes back as text, colours stripped.

import { REPO } from "../lib/paths.ts";

/** Allowed actions to CLI arguments. `opts` accepted per action (anything else is ignored). */
export const ACTIONS: Record<string, { args: string[]; opts?: Record<string, string[]>; timeoutMs?: number }> = {
  "doctor": { args: ["doctor"] },
  "sync-fetch": { args: ["sync", "--fetch"], timeoutMs: 30000 },
  "mcp-check": { args: ["mcp", "check"] },
  "mcp-sync": { args: ["mcp", "sync"], opts: { force: ["--force"] } },
  "install-dry": { args: ["install", "--dry-run"] },
  "install": { args: ["install"] },
  "usage-ingest": { args: ["usage", "ingest", "--full"], timeoutMs: 120000 },
  "update-check": { args: ["update", "--check"], timeoutMs: 40000 },
  "update-now": { args: ["update", "--auto"], timeoutMs: 900000 },
  "rollback-cli": { args: ["update", "--rollback"] },
  "rollback-desktop": { args: ["update", "--rollback", "--desktop"], timeoutMs: 180000 },
};

/** Runs an allowed action through bin/claude-multi; an unknown name answers code 2 without running. */
export async function runAction(name: string, opts: string[]) {
  const a = ACTIONS[name];
  if (!a) return { code: 2, output: `unknown action: ${name}`, ms: 0 };
  const extra = (opts ?? []).flatMap((o) => a.opts?.[o] ?? []);
  const t0 = Date.now();
  const cmd = new Deno.Command(`${REPO}/bin/claude-multi`, {
    args: [...a.args, ...extra],
    cwd: REPO,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  });
  const child = cmd.spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch { /* already gone */ }
  }, a.timeoutMs ?? 60000);
  const r = await child.output();
  clearTimeout(timer);
  const dec = new TextDecoder();
  // deno-lint-ignore no-control-regex
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  let output = strip(dec.decode(r.stdout));
  const err = strip(dec.decode(r.stderr)).trim();
  if (err) output += (output ? "\n" : "") + err;
  // update --check exits 10 when an update exists: not an error (the check writes its own cache)
  if (name === "update-check") return { code: r.code === 10 ? 0 : r.code, output, ms: Date.now() - t0 };
  return { code: r.code, output, ms: Date.now() - t0 };
}
