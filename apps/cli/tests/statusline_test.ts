// Tests for shared/statusline-command.sh: the segments it prints from the session's JSON and the
// local caches, the snapshot it leaves for the console, and names with % or \ printed as they are.
import { assertEquals } from "jsr:@std/assert@1";

const SCRIPT = new URL("../../../shared/statusline-command.sh", import.meta.url).pathname;

async function line(payload: unknown, home: string): Promise<string> {
  const child = new Deno.Command("bash", {
    args: [SCRIPT],
    clearEnv: true, // PATH without ~/.local/bin: the script must not start the real `agents` for its cache
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
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

// two lines, each indented by one space, with a braille blank (U+2800) after each
const two = (l1: string, l2: string) => ` ${l1}\n\u2800\n ${l2}\n\u2800`;

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
      two(
        "100% \\done",
        "work │ Opus 5.5 │ [██████░░░░] 63% 634.1k/1000k │ 5h 81% ↻ 00:00 │ $12.35 │ cfg ↓2 cfg ✎3 cfg offline │ ⬆ code 9.9.9",
      ),
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
      two("100% \\done", "work │ [█░░░░░░░░░] 5% 512/200k │ cfg ↓2 cfg ✎3 cfg offline │ ⬆ code 9.9.9"),
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("statusline: the folder's tasks from the profile's cache, the 7d limit with its weekday", async () => {
  const home = await Deno.makeTempDir();
  try {
    const cwd = `${home}/work/acme/site`;
    await Deno.mkdir(cwd, { recursive: true });
    await Deno.mkdir(`${home}/.cache/agents-multi`, { recursive: true });
    const at = Math.floor(Date.now() / 1000);
    const t = (p: string, s: string, extra: object = {}) => ({ id: "t-1", r: "t-1", p, s, ...extra });
    await Deno.writeTextFile(
      `${home}/.cache/agents-multi/tasks-line-work.json`,
      JSON.stringify({
        at,
        tasks: [
          t("work/acme/site", "todo", { r: "TASK-495", pr: 1 }), // the folder itself, P1
          t("work/acme", "todo", { d: "2020-01-01" }), // the client above it, overdue
          t("work/acme/site/api", "doing"), // below it
          t("work/acme/site", "waiting", { pr: 1 }), // waiting: not a P1 to act on
          t("work/other", "todo"), // somewhere else: not shown
        ],
      }),
    );
    const out = await line({ cwd, rate_limits: { seven_day: { used_percentage: 20, resets_at: 1792200000 } } }, home);
    const [l1, , l2] = out.split("\n");
    assertEquals(l1, " site │ 4 task · 2 todo · 1 doing · 1 waiting · 1 overdue · P1 495");
    assertEquals(l2.includes("7d 20% ↻ "), true);
    // another folder, or nothing under ~, shows no task segment
    assertEquals((await line({ cwd: `${home}/work/other2` }, home)).split("\n")[0], " other2");
    assertEquals((await line({ cwd: "/" }, home)).split("\n")[0], " ");
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("statusline cache: only open tasks that belong to a folder, in short records", async () => {
  const { lineCache } = await import("../tasks.ts");
  const base = { title: "x", created: "", updated: "" };
  const c = lineCache([
    { ...base, id: "a", status: "todo", project: "p/q", ref: "TASK-1", priority: 1, due: "2026-10-01" },
    { ...base, id: "b", status: "done", project: "p/q" },
    { ...base, id: "c", status: "doing" }, // no folder
    { ...base, id: "d", status: "waiting", project: "p" },
  ], 7);
  assertEquals(c, {
    at: 7,
    tasks: [
      { id: "a", r: "TASK-1", p: "p/q", s: "todo", pr: 1, d: "2026-10-01" },
      { id: "d", r: "d", p: "p", s: "waiting", pr: undefined, d: undefined },
    ],
  });
});
