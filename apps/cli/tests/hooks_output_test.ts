// The hooks that inject context (shared/hooks) print valid hook JSON when they fire: Claude Code
// drops output that does not parse, silently, so a quoting mistake turns a hook off unnoticed.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";

const HOOKS = new URL("../../../shared/hooks/", import.meta.url).pathname;

async function fire(hook: string, payload: unknown, env: Record<string, string>, cwd: string) {
  const child = new Deno.Command("bash", {
    args: [`${HOOKS}${hook}`],
    cwd,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify(payload)));
  await w.close();
  const out = new TextDecoder().decode((await child.output()).stdout).trim();
  return JSON.parse(out).hookSpecificOutput as { hookEventName: string; additionalContext: string };
}

Deno.test("hooks: graphify-nudge, agents-md-nested and brain-nudge print parseable JSON when they fire", async () => {
  const home = await Deno.makeTempDir();
  try {
    const proj = `${home}/work/acme/site`;
    await Deno.mkdir(`${proj}/graphify-out`, { recursive: true });
    await Deno.mkdir(`${proj}/sub`);
    await Deno.writeTextFile(`${proj}/graphify-out/graph.json`, "{}");
    await Deno.writeTextFile(`${proj}/sub/AGENTS.md`, '# rules with "quotes" and `ticks`');
    const env = { HOME: home, CLAUDE_PROJECT_DIR: proj, PATH: Deno.env.get("PATH") ?? "" };

    const g = await fire(
      "graphify-nudge.sh",
      { tool_name: "Bash", tool_input: { command: "grep -rn x ." } },
      env,
      proj,
    );
    assertStringIncludes(g.additionalContext, 'graphify query "<question>"');

    const a = await fire(
      "agents-md-nested.sh",
      {
        session_id: `t-${crypto.randomUUID()}`,
        cwd: proj,
        tool_name: "Read",
        tool_input: { file_path: `${proj}/sub/x.ts` },
      },
      env,
      proj,
    );
    assertStringIncludes(a.additionalContext, '# rules with "quotes" and `ticks`');

    const b = await fire("brain-nudge.sh", { hook_event_name: "SessionStart", cwd: proj }, env, proj);
    assertEquals(b.hookEventName, "SessionStart");
    assertStringIncludes(b.additionalContext, "~/work/acme/site");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

/** The raw output of a hook: what it prints, empty when it does not fire. */
async function raw(hook: string, payload: unknown, env: Record<string, string>, cwd: string) {
  const child = new Deno.Command("bash", {
    args: [`${HOOKS}${hook}`],
    cwd,
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  })
    .spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify(payload)));
  await w.close();
  return new TextDecoder().decode((await child.output()).stdout).trim();
}

Deno.test("brain-nudge: silent for a profile whose manifest in the runtime's config has brainScope", async () => {
  const home = await Deno.makeTempDir();
  try {
    const proj = `${home}/work/acme/site`;
    await Deno.mkdir(proj, { recursive: true });
    await Deno.mkdir(`${home}/.agents-multi/config/profiles/work`, { recursive: true });
    await Deno.writeTextFile(`${home}/.agents-multi/config/profiles/work/profile.json`, '{"brainScope":["work"]}');
    const env = { HOME: home, CLAUDE_CONFIG_DIR: `${home}/.agents-multi/work`, PATH: Deno.env.get("PATH") ?? "" };
    assertEquals(await raw("brain-nudge.sh", { hook_event_name: "SessionStart", cwd: proj }, env, proj), "");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("memory-legacy-guard: denies the auto-memory under either runtime name, not a repository's memory/", async () => {
  const env = { HOME: "/h", PATH: Deno.env.get("PATH") ?? "" };
  const decide = async (file_path: string) => {
    const out = await raw("memory-legacy-guard.sh", { tool_name: "Write", tool_input: { file_path } }, env, "/");
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
  };
  assertEquals(await decide("/h/.agents-multi/personal/projects/-h-x/memory/MEMORY.md"), "deny");
  assertEquals(await decide("/h/.claude-multi/personal/projects/-h-x/memory/MEMORY.md"), "deny");
  assertEquals(await decide("/h/.claude/projects/-h-x/memory/a.md"), "deny");
  assertEquals(await decide("/h/code/app/projects/x/memory/a.md"), "allow");
});
