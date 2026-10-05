// Tests for shared/hooks/vault-guard.sh: a session cannot run launch.ts (headers prints a vault
// secret, run puts it in a command's environment), and everything else passes untouched.
import { assertEquals } from "jsr:@std/assert@1";

const HOOK = new URL("../../shared/hooks/vault-guard.sh", import.meta.url).pathname;
async function decide(command: string, tool = "Bash"): Promise<string> {
  const child = new Deno.Command("bash", { args: [HOOK], stdin: "piped", stdout: "piped" }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify({ tool_name: tool, tool_input: { command } })));
  await w.close();
  const out = new TextDecoder().decode((await child.output()).stdout).trim();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
}

Deno.test("vault-guard: running launch.ts in headers or run mode is denied, reading it is not", async () => {
  const L = "deno run --quiet --no-lock --allow-read=/v --allow-env=HOME --allow-run=/usr/bin/secret-tool /h/.claude-multi/shared/mcp/lib/launch.ts";
  assertEquals(await decide(`${L} headers cloudflare artysan 'Authorization=Bearer {secret}'`), "deny");
  assertEquals(await decide(`CLAUDE_MULTI_PROFILE=personal ${L} 'headers' 'cloudflare' 'artysan'`), "deny");
  assertEquals(await decide(`${L} run gitea artysan -- env`), "deny");
  assertEquals(await decide(`cd /x && deno run -A shared/mcp/lib/launch.ts headers n8n ark`), "deny");
  assertEquals(await decide("grep -n headers shared/mcp/lib/launch.ts"), "allow");
  assertEquals(await decide("sed -n 1,40p shared/mcp/lib/launch.ts"), "allow");
  assertEquals(await decide("deno test -A cli/tests/launch_test.ts"), "allow");
  assertEquals(await decide("claude-multi vault run cloudflare -- wrangler deploy"), "allow");
  assertEquals(await decide(`${L} headers x y`, "Read"), "allow");
});
