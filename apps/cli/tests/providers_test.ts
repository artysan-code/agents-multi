// Tests for the provider interface (shared/mcp/lib/providers.ts, limits.ts) and `agents limits`
// (apps/cli/limits.ts): accounts from manifests, usage windows in one shape from a status line's snapshots and
// a Codex session log (made-up numbers), a child's pid file under its old and new name. Everything in temp folders.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { childAlive } from "../../../shared/mcp/lib/agents.ts";
import { claudeWindows, codexWindows, type LimitSnapshot, windowName } from "../../../shared/mcp/lib/limits.ts";
import {
  accountLimits,
  allLimits,
  listAccounts,
  mcpTokenFile,
  type Places,
  providers,
} from "../../../shared/mcp/lib/providers.ts";
import { codexHome } from "../../../shared/mcp/lib/codex.ts";
import { tokenFileOf } from "../mcp/gateway-settings.ts";
import { inHours, limitsTable, limitsView, readAgo } from "../limits.ts";

const NOW = 1_800_000_000;

Deno.test("limits: a window's length by name", () => {
  assertEquals([300, 10080, 43200, 90, 45].map(windowName), ["5h", "7d", "30d", "90m", "45m"]);
});

Deno.test("limits: Claude's windows are the newest snapshot's of the profile, the reset ones left out", () => {
  const snaps: LimitSnapshot[] = [
    {
      at: NOW - 900,
      profile: "a",
      limits: { five_hour: { used: 10, resets: NOW + 100 }, seven_day: { used: 5, resets: NOW + 900 } },
    },
    {
      at: NOW - 100,
      profile: "a",
      limits: { five_hour: { used: 40, resets: NOW + 1000 }, seven_day: { used: 6, resets: NOW + 90000 } },
      source: "endpoint",
    },
    { at: NOW - 50, profile: "b", limits: { five_hour: { used: 99, resets: NOW - 1 } } }, // already reset: unknown
    { at: NOW - 10, profile: "a" }, // no limits: not the newest reading
  ];
  assertEquals(claudeWindows(snaps, "a", NOW), [
    { window: "5h", usedPercent: 40, resetsAt: NOW + 1000, source: "endpoint", at: NOW - 100 },
    { window: "7d", usedPercent: 6, resetsAt: NOW + 90000, source: "endpoint", at: NOW - 100 },
  ]);
  assertEquals(claudeWindows(snaps, "b", NOW), []);
  assertEquals(claudeWindows(snaps, "none", NOW), []);
});

Deno.test("limits: Codex's windows in the same shape", () => {
  const l = {
    primary: { window: 300, used_percent: 42.5, resets_at: NOW + 60 },
    secondary: { window: 10080, used_percent: 4, resets_at: NOW - 5 },
    plan: "plus",
    at: "2027-01-15T08:00:00Z",
  };
  assertEquals(codexWindows(l, NOW), [
    { window: "5h", usedPercent: 42.5, resetsAt: NOW + 60, source: "codex-log", at: Date.parse(l.at) / 1000 },
  ]);
  assertEquals(codexWindows(null, NOW), []);
});

Deno.test("providers: accounts come from the manifests, capabilities say what each can do", async () => {
  const config = await Deno.makeTempDir();
  try {
    for (const [p, m] of [["zed", {}], ["ann", { codex: true }], ["bob", { codex: false }]] as const) {
      await Deno.mkdir(`${config}/profiles/${p}`, { recursive: true });
      await Deno.writeTextFile(`${config}/profiles/${p}/profile.json`, JSON.stringify(m));
    }
    await Deno.mkdir(`${config}/profiles/notaprofile`); // no profile.json
    assertEquals((await listAccounts(config)).map((a) => a.id), [
      "ann/claude",
      "ann/codex",
      "bob/claude",
      "zed/claude",
    ]);
  } finally {
    await Deno.remove(config, { recursive: true });
  }
  assertEquals(providers.claude.capabilities, { nativeQuestions: true, permissionRequests: true, costReported: true });
  assertEquals(providers.codex.capabilities, {
    nativeQuestions: false,
    permissionRequests: false,
    costReported: false,
  });
  // the token file the Codex provider reads is the one the gateway's launch config names
  assertEquals(mcpTokenFile("/rt", "p"), tokenFileOf("p", "/rt"));
});

Deno.test("limits: every account's windows from a status line snapshot and a Codex log, nothing else read", async () => {
  const root = await Deno.makeTempDir();
  try {
    const at: Places = { config: `${root}/config`, runtime: `${root}/rt`, live: `${root}/live` };
    await Deno.mkdir(at.live, { recursive: true });
    await Deno.mkdir(`${at.config}/profiles/ann`, { recursive: true });
    await Deno.mkdir(`${at.config}/profiles/bob`, { recursive: true });
    await Deno.writeTextFile(`${at.config}/profiles/ann/profile.json`, '{"codex":true}');
    await Deno.writeTextFile(`${at.config}/profiles/bob/profile.json`, "{}");
    await Deno.writeTextFile(
      `${at.live}/s1.json`,
      JSON.stringify({ at: NOW - 10, profile: "ann", limits: { five_hour: { used: 12, resets: NOW + 500 } } }),
    );
    await Deno.writeTextFile(`${at.live}/broken.json`, "{nope");
    const log = `${codexHome(at.runtime, "ann")}/sessions/2027/01/15`;
    await Deno.mkdir(log, { recursive: true });
    await Deno.writeTextFile(
      `${log}/rollout-x.jsonl`,
      JSON.stringify({
        timestamp: "2027-01-15T08:00:00Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          rate_limits: {
            primary: { used_percent: 30, window_minutes: 300, resets_at: NOW + 700 },
            secondary: { used_percent: 8, window_minutes: 10080, resets_at: NOW + 70000 },
          },
        },
      }) + "\n",
    );
    const all = await allLimits(at, NOW);
    assertEquals(all.map((a) => [a.account.id, a.windows.map((w) => `${w.window}:${w.usedPercent}:${w.source}`)]), [
      ["ann/claude", ["5h:12:statusline"]],
      ["ann/codex", ["5h:30:codex-log", "7d:8:codex-log"]],
      ["bob/claude", []],
    ]);
    assertEquals((await accountLimits({ id: "ann/codex", profile: "ann", provider: "codex" }, at, NOW)).length, 2);

    // the table: a line per window, and one for an account with no reading
    const lines = limitsTable(all, NOW);
    assertEquals(lines.length, 4);
    assert(lines[0].startsWith("ann/claude") && lines[0].includes("12%") && lines[0].includes("resets in 8m"));
    assert(lines[3].startsWith("bob/claude") && lines[3].includes("no reading"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("limits: a reading's age as a person reads it, stale past half an hour", () => {
  assertEquals([null, NOW, NOW - 240, NOW - 1799, NOW - 3 * 3600, NOW - 2 * 86400].map((a) => readAgo(a, NOW)), [
    "read —",
    "read now",
    "read 4m ago",
    "read 29m ago",
    "read 3h ago, stale",
    "read 2d ago, stale",
  ]);
});

Deno.test("limitsView: every window marked stale by the same rule as the table, half an hour", () => {
  const w = (at: number | null) => ({
    window: "5h",
    usedPercent: 40,
    resetsAt: NOW + 600,
    source: "statusline" as const,
    at,
  });
  const v = limitsView([
    { account: { id: "a/claude", profile: "a", provider: "claude" }, windows: [w(NOW - 60), w(NOW - 1801), w(null)] },
    { account: { id: "a/codex", profile: "a", provider: "codex" }, windows: [] },
  ], NOW);
  assertEquals(v.now, NOW);
  assertEquals(v.accounts[0].windows.map((x) => x.stale), [false, true, false]);
  assertEquals(v.accounts[1].windows, []);
});

Deno.test("limits: a reset as a person reads it", () => {
  assertEquals([null, NOW - 1, NOW + 90, NOW + 7500, NOW + 90000].map((r) => inHours(r, NOW)), [
    "—",
    "now",
    "in 1m",
    "in 2h 5m",
    "in 1d 1h",
  ]);
});

Deno.test("agents: a child's process is child.pid, or claude.pid in a child older than the name", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await childAlive(dir), false);
    await Deno.writeTextFile(`${dir}/claude.pid`, String(Deno.pid));
    assertEquals(await childAlive(dir), true);
    await Deno.remove(`${dir}/claude.pid`);
    await Deno.writeTextFile(`${dir}/child.pid`, String(Deno.pid));
    assertEquals(await childAlive(dir), true);
    await Deno.writeTextFile(`${dir}/child.pid`, "0");
    assertEquals(await childAlive(dir), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("providers: a Claude child's ask rules go in a --settings of its own, its deny rules beside them", async () => {
  const base = { command: "claude-x", mode: "auto" as const, profile: "x", runtime: "/r" };
  const plain = await providers.claude.exec(base);
  assert(!("S" in plain.env));
  const forced = await providers.claude.exec({
    ...base,
    askTools: ["mcp__google__gmail_send", "Bash(wrangler deploy:*)"],
    disallowedTools: ["Bash(npm publish:*)"],
  });
  assertEquals(JSON.parse(forced.env.S), {
    permissions: { ask: ["mcp__google__gmail_send", "Bash(wrangler deploy:*)"] },
  });
  assertEquals(forced.env.X, "Bash(npm publish:*)");
  assert(forced.line.includes('${S:+--settings "$S"}'), "the value reaches the line as a variable, never as text");
});
