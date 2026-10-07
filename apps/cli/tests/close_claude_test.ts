// Tests for «Close Claude and update» (console/close-claude.ts): which blockers are listed, that the
// console's own tree is never signalled, and when the button shows. Process listing is injected: no
// real Claude process is ever signalled here.
import { assertEquals } from "jsr:@std/assert@1";
import { launchers } from "../lib/profiles.ts";
import {
  closeOffer,
  closePlan,
  closeSessions,
  type Deps,
  listBlockers,
  parentFromStat,
  reopen,
} from "../console/close-claude.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const cli = (pid: number, profile: string, lastActivity: string | null = null, embedded = false) => ({
  pid,
  profile,
  cwd: null,
  embedded,
  version: "2.1.0",
  session: null,
  model: null,
  lastActivity,
});
const running = {
  cli: [cli(10, "a", "2026-10-07T11:59:30Z"), cli(11, "a", "2026-10-07T10:00:00Z"), cli(12, "b", null, true)],
  desktop: [{ pid: 20, variant: "b" }, { pid: 99, variant: "ghost" }],
};

Deno.test("close claude: blockers per profile, busy by recent transcript, Desktop says nothing, unknown profiles skipped", () => {
  const bs = listBlockers(running, ["a", "b"], new Set(), new Map([[10, 5]]), NOW);
  assertEquals(bs.map((b) => [b.key, b.pid, b.busy, b.ageSec, b.embedded]), [
    ["cli:a", 10, true, 5, false],
    ["cli:a", 11, false, null, false],
    ["cli:b", 12, false, null, true],
    ["desktop:b", 20, null, null, false],
  ]);
});

Deno.test("close claude: the button shows only for an install waiting on open Claude instances", () => {
  const bs = listBlockers(running, ["a"], new Set(), new Map(), NOW);
  assertEquals(closeOffer("abc123", bs), true);
  assertEquals(closeOffer(null, bs), false); // update skipped for another reason: nothing pending
  assertEquals(closeOffer("abc123", []), false); // nothing open: Update now is enough
});

Deno.test("close claude: parent pid out of /proc stat, whatever the name holds", () => {
  assertEquals(parentFromStat("123 (claude (x) y) S 77 1 2"), 77);
  assertEquals(parentFromStat("123 (deno) S 0 1 2"), null);
});

function deps(over: Partial<Deps> = {}) {
  const alive = new Set([10, 11, 12, 20]);
  const sent: [number, string][] = [];
  const notes: string[][] = [];
  const d: Deps = {
    running: () =>
      Promise.resolve({
        cli: running.cli.filter((c) => alive.has(c.pid)),
        desktop: running.desktop.filter((x) => alive.has(x.pid)),
      }),
    profiles: () => Promise.resolve(["a", "b"]),
    protectedPids: () => Promise.resolve(new Set([11])), // the console runs under session 11
    ages: () => Promise.resolve(new Map()),
    pending: () => Promise.resolve("abc123"),
    signal: (pid, sig) => {
      sent.push([pid, sig]);
      if (sig === "SIGKILL" || pid !== 12) alive.delete(pid); // 12 ignores TERM
    },
    sleep: () => Promise.resolve(),
    note: (event, head, detail) => {
      notes.push([event, head, detail]);
      return Promise.resolve();
    },
    ...over,
  };
  return { d, sent, notes };
}

Deno.test("close claude: the plan lists the console's own tree as protected", async () => {
  const { d } = deps();
  const p = await closePlan(d);
  assertEquals(p.offer, true);
  assertEquals(p.blockers.filter((b) => b.protected).map((b) => b.pid), [11]);
});

Deno.test("close claude: TERM spares the console's tree, reports who did not go, KILL finishes them and Desktop is reopened", async () => {
  const { d, sent, notes } = deps();
  const t = await closeSessions("SIGTERM", 1000, d);
  assertEquals(sent.map(([p]) => p).sort(), [10, 12, 20]); // never 11
  assertEquals(t.remaining.map((b) => b.pid), [12]);
  assertEquals(t.closed.map((b) => b.pid).sort(), [10, 20]);
  assertEquals(t.reopen, ["b"]);
  assertEquals(notes[0][0], "closed");
  const k = await closeSessions("SIGKILL", 1000, d);
  assertEquals(sent.filter(([, s]) => s === "SIGKILL").map(([p]) => p), [12]);
  assertEquals(k.remaining, []);
  assertEquals(notes[1][0], "force-closed");
  assertEquals(sent.some(([p]) => p === 11), false);
});

Deno.test("close claude: nothing is signalled when no install is waiting", async () => {
  const { d, sent } = deps({ pending: () => Promise.resolve(null) });
  const r = await closeSessions("SIGTERM", 1000, d);
  assertEquals([r.ok, sent], [false, []]);
});

Deno.test("close claude: reopen starts only profiles the manifests declare, through the one launcher", async () => {
  const started: string[][] = [];
  const known = (await launchers())[0].profile;
  const names = await reopen([known, "../x", "nope"], (bin, args) => {
    started.push([bin.split("/").pop()!, ...args]);
    return Promise.resolve();
  });
  assertEquals(names, [known]);
  assertEquals(started[0].slice(1), [known]);
  assertEquals(started.every((s) => s[0] === "claude-launch"), true);
});
