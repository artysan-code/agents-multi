// nodes_view_test.ts — `agents nodes` (apps/cli/nodes.ts) and the doctor's node checks (doctor/checks/node.ts):
// what the owner reads of the machines and jobs, what they sign, and what the doctor says of this node.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { cleanNodeConfig } from "../../../shared/mcp/lib/headless.ts";
import type { Job, NodeInfo } from "../../../shared/mcp/lib/nodes.ts";
import type { Routine } from "../../../shared/mcp/lib/routines.ts";
import { exposed, nodeFindings } from "../doctor/checks/node.ts";
import { acceptSummary, ago, jobLine, jobsToShow, nodeLines, routineSpec } from "../nodes.ts";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const node = (o: Partial<NodeInfo> = {}): NodeInfo => ({
  name: "fisso",
  platform: "linux",
  version: "1.2.0",
  headless: false,
  load: 0.5,
  memTotal: 32 * 2 ** 30,
  memFree: 20 * 2 ** 30,
  cap: 4,
  running: 1,
  accounts: ["personal/claude"],
  present: true,
  sandbox: null,
  seen: iso(5_000),
  ...o,
});

const job = (o: Partial<Job> = {}): Job => ({
  id: "j1",
  node: "atlas",
  kind: "routine",
  spec: { name: "night", repo: "git.example/me/repo", path: "", action: { kind: "agent" }, account: "personal/claude" },
  status: "proposed",
  created: iso(60_000),
  updated: iso(60_000),
  by: "fisso",
  ...o,
});

Deno.test("nodes: ago reads as a person does", () => {
  assertEquals([iso(5_000), iso(4 * 60_000), iso(3 * 3600_000), iso(2 * 86400_000)].map((t) => ago(t, NOW)), [
    "now",
    "4m",
    "3h",
    "2d",
  ]);
});

Deno.test("nodes: a line per node, offline and full said, and none at all said too", () => {
  assertStringIncludes(nodeLines([], NOW)[0], "agents node enable");
  const lines = nodeLines([
    node(),
    node({ name: "atlas", headless: true, present: false, sandbox: true, running: 2, cap: 2 }),
    node({ name: "portatile", seen: iso(3600_000) }),
  ], NOW);
  assertEquals(lines.length, 3);
  assert(lines[0].startsWith("atlas") && lines[0].includes("server") && lines[0].includes("full (2/2 sessions)"));
  assert(lines[1].startsWith("fisso") && lines[1].includes("owner at it") && !lines[1].includes("takes nothing"));
  assert(lines[2].startsWith("portatile") && lines[2].includes("offline (1h)"));
});

Deno.test("nodes: the jobs shown are the open ones, proposals first, then the last ended", () => {
  const jobs = [
    job({ id: "run", status: "running", created: iso(10_000) }),
    job({ id: "old", status: "done", updated: iso(86400_000) }),
    job({ id: "prop", status: "proposed", created: iso(5_000) }),
    job({ id: "new", status: "failed", updated: iso(1000) }),
  ];
  assertEquals(jobsToShow(jobs).map((j) => j.id), ["prop", "run", "new", "old"]);
  assertEquals(jobsToShow(jobs, 1).map((j) => j.id), ["prop", "run", "new"]);
  const line = jobLine(job({ status: "accepted", expires: new Date(NOW + 2 * 3600_000).toISOString() }), NOW);
  assertStringIncludes(line, "accepted");
  assertStringIncludes(line, "holds in 2h");
  assertStringIncludes(jobLine(job({ kind: "resume", node: "" }), NOW), "no node yet  resume night");
});

Deno.test("nodes: a routine's job finds its repository by remote and its folder inside it", () => {
  const r = {
    id: "night-ab12",
    name: "night",
    trigger: { kind: "at", at: "2026-10-15T00:00:00.000Z" },
    action: { kind: "agent", profile: "funnel", task: "x" },
    folder: "/h/repo/apps/site",
    project: "/h/repo",
    enabled: true,
    created: "2026-10-15T00:00:00.000Z",
  } as Routine;
  const s = routineSpec(r, "/h/repo", "git@git.example.org:me/Repo.git");
  assertEquals([s.repo, s.path, s.account, s.name], ["git.example.org/me/repo", "apps/site", "funnel/claude", "night"]);
  assertEquals(routineSpec({ ...r, folder: "/h/repo" }, "/h/repo", "https://x.org/a/b").path, "");
  const wf = routineSpec(
    { ...r, action: { kind: "workflow", plan: "p.json" } } as Routine,
    "/h/repo",
    "https://x.org/a/b",
  );
  assertEquals(wf.account, undefined);
});

Deno.test("nodes: what is signed is said in full first", () => {
  const s = acceptSummary(job({ reason: "fisso went silent" }), "atlas", "2026-10-16T12:00:00.000Z");
  assertStringIncludes(s[0], "routine night on atlas, until 2026-10-16T12:00:00.000Z");
  assert(s.some((l) => l.includes('{"kind":"agent"}')));
  assert(s.some((l) => l.includes("fisso went silent")));
});

Deno.test("doctor node: only loopback on our ports; the key file the user's alone; a node on needs service and key", () => {
  const ss = [
    "LISTEN 0 4096 127.0.0.1:7331 0.0.0.0:*",
    "LISTEN 0 4096 0.0.0.0:7332 0.0.0.0:*",
    "LISTEN 0 4096 [::1]:7331 [::]:*",
    "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
  ].join("\n");
  assertEquals(exposed(ss), ["0.0.0.0:7332"]);
  const off = cleanNodeConfig({});
  const base = { cfg: off, keyMode: null, exposed: [], service: null, approval: false };
  const ids = (c: { id: string; status: string }[]) => c.map((x) => `${x.id}:${x.status}`);
  assertEquals(ids(nodeFindings(base)), ["node.bind:ok", "node.on:ok"]);
  assertEquals(ids(nodeFindings({ ...base, exposed: ["0.0.0.0:7332"], keyMode: 0o644 })), [
    "node.bind:fail",
    "node.keyfile:fail",
    "node.on:ok",
  ]);
  const on = cleanNodeConfig({ enabled: true, headless: true });
  assertEquals(ids(nodeFindings({ ...base, cfg: on, keyMode: 0o600 })), [
    "node.bind:ok",
    "node.keyfile:ok",
    "node.service:fail",
    "node.approval:fail",
  ]);
  assertEquals(ids(nodeFindings({ ...base, cfg: on, service: "https://brain.x", approval: true })), [
    "node.bind:ok",
    "node.service:ok",
  ]);
});
