// Tests for shared/statusline-command.sh: the segments it prints from the session's JSON and the
// local caches, the snapshot it leaves for the console, and names with % or \ printed as they are.
import { assertEquals } from "jsr:@std/assert@1";

const SCRIPT = new URL("../../../shared/statusline-command.sh", import.meta.url).pathname;

async function line(payload: unknown, home: string): Promise<string> {
  const child = new Deno.Command("bash", {
    args: [SCRIPT],
    env: {
      HOME: home,
      XDG_STATE_HOME: `${home}/state`,
      XDG_CACHE_HOME: `${home}/.cache`,
      CLAUDE_CONFIG_DIR: "/x/work",
    },
    stdin: "piped",
    stdout: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify(payload)));
  await w.close();
  // deno-lint-ignore no-control-regex -- the colours are what is stripped
  return new TextDecoder().decode((await child.output()).stdout).replace(/\x1b\[[0-9;]*m/g, "");
}

Deno.test("statusline: folder, model, context, limit, cost, the caches' state, and the snapshot", async () => {
  const home = await Deno.makeTempDir();
  try {
    const cwd = `${home}/100% \\done`; // not a repository: no git segment
    await Deno.mkdir(cwd);
    await Deno.mkdir(`${home}/.cache/agents-multi`, { recursive: true });
    await Deno.mkdir(`${home}/.cache/claude-update`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.cache/agents-multi/sync.json`,
      JSON.stringify({ behind: 2, ahead: 0, dirty: 3, fetch_ok: false, upstream: true }),
    );
    await Deno.writeTextFile(
      `${home}/.cache/claude-update/check.json`,
      JSON.stringify({ cli: { outdated: true, latest: "9.9.9" }, desktop: { outdated: false, latest: "1" } }),
    );
    const payload = {
      session_id: "s-1",
      workspace: { current_dir: cwd },
      model: { display_name: "Claude Opus 5.5" },
      context_window: { used_percentage: 63.4, used_tokens: 634123, total_tokens: 1000000 },
      cost: { total_cost_usd: 12.3456 },
      rate_limits: { five_hour: { used_percentage: 81.2, resets_at: 1 } },
    };
    assertEquals(
      await line(payload, home),
      "100% \\done │ Opus 5.5 │ [██████░░░░] 63% 634.1k/1000k │ 5h 81% │ $12.35 │ cfg ↓2 cfg ✎3 cfg offline │ ⬆ code 9.9.9",
    );
    const snap = JSON.parse(await Deno.readTextFile(`${home}/state/agents-multi/live/s-1.json`));
    assertEquals([snap.profile, snap.model, snap.context.used, snap.limits.five_hour.used], [
      "work",
      "Claude Opus 5.5",
      63.4,
      81.2,
    ]);
    // a free session: no cost segment, small numbers as they are
    assertEquals(
      await line({
        cwd,
        context_window: { used_percentage: 5, used_tokens: 512, total_tokens: 200000 },
        cost: { total_cost_usd: 0 },
      }, home),
      "100% \\done │ [█░░░░░░░░░] 5% 512/200k │ cfg ↓2 cfg ✎3 cfg offline │ ⬆ code 9.9.9",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
