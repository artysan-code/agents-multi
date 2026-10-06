// Tests for shared/hooks/vault-guard.sh: a session cannot run launch.ts (headers prints a vault
// secret, run puts it in a command's environment), and everything else passes untouched — with jq,
// and without it, where shared/hooks/lib/guard.sh parses the payload instead.
import { assertEquals } from "jsr:@std/assert@1";

const HOOK = new URL("../../../shared/hooks/vault-guard.sh", import.meta.url).pathname;

/** A PATH holding only the tools the guard needs besides jq, as symlinks in a temporary folder. */
async function pathWithoutJq(): Promise<string> {
  const dir = await Deno.makeTempDir();
  for (const tool of ["bash", "cat", "sed", "grep", "head", "tr", "dirname"]) {
    const { stdout } = await new Deno.Command("bash", { args: ["-c", `command -v ${tool}`], stdout: "piped" }).output();
    await Deno.symlink(new TextDecoder().decode(stdout).trim(), `${dir}/${tool}`);
  }
  return dir;
}

async function decide(command: string, tool: string, path?: string): Promise<string> {
  const env = path ? { PATH: path } : undefined;
  const child = new Deno.Command("bash", { args: [HOOK], stdin: "piped", stdout: "piped", env }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify({ tool_name: tool, tool_input: { command } })));
  await w.close();
  const out = new TextDecoder().decode((await child.output()).stdout).trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
}

const L =
  "deno run --quiet --no-lock --allow-read=/v --allow-env=HOME --allow-run=/usr/bin/secret-tool /h/.claude-multi/shared/mcp/lib/launch.ts";
const CASES: [string, string, string][] = [
  ["deny", `${L} headers cloudflare main 'Authorization=Bearer {secret}'`, "Bash"],
  ["deny", `CLAUDE_MULTI_PROFILE=personal ${L} 'headers' 'cloudflare' 'main'`, "Bash"],
  ["deny", `${L} "run" gitea main -- env`, "Bash"],
  ["deny", `cd /x && deno run -A shared/mcp/lib/launch.ts headers n8n main`, "Bash"],
  ["allow", "grep -n headers shared/mcp/lib/launch.ts", "Bash"],
  ["allow", "sed -n 1,40p shared/mcp/lib/launch.ts", "Bash"],
  ["allow", "deno test -A apps/cli/tests/launch_test.ts", "Bash"],
  ["allow", "claude-multi vault run cloudflare -- wrangler deploy", "Bash"],
  ["allow", `${L} headers x y`, "Read"],
];

Deno.test("vault-guard: running launch.ts in headers or run mode is denied, reading it is not", async () => {
  for (const [want, command, tool] of CASES) assertEquals(await decide(command, tool), want, command);
});

Deno.test("vault-guard: without jq it decides the same, never a silent allow", async () => {
  const path = await pathWithoutJq();
  try {
    for (const [want, command, tool] of CASES) assertEquals(await decide(command, tool, path), want, command);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});
