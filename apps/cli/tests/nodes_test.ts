// nodes_test.ts — what the machines and the service share about nodes and jobs (shared/mcp/lib/nodes.ts):
// the session cap, presence, remotes, placement, what a silent node's jobs become, and the owner's signature.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  approvalKeys,
  canonical,
  type Job,
  type JobSpec,
  memoryLimit,
  type NodeInfo,
  nodeNameOf,
  normalRemote,
  place,
  presentFrom,
  resumeOf,
  sessionCap,
  signJob,
  specErrors,
  sweep,
  verifyJob,
} from "../../../shared/mcp/lib/nodes.ts";

const GiB = 2 ** 30;
const NOW = Date.parse("2026-10-15T20:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const node = (name: string, x: Partial<NodeInfo> = {}): NodeInfo => ({
  name,
  platform: "linux",
  version: "1.2.0",
  headless: false,
  load: 0.5,
  memTotal: 32 * GiB,
  memFree: 20 * GiB,
  cap: 4,
  running: 0,
  accounts: ["work/claude"],
  present: false,
  sandbox: null,
  seen: ago(10),
  ...x,
});

const spec: JobSpec = { name: "nightly", repo: "git.example.com/me/site", path: "", action: { kind: "agent" } };
const job = (id: string, x: Partial<Job> = {}): Job => ({
  id,
  node: "desk",
  kind: "routine",
  spec,
  status: "running",
  created: ago(3600),
  updated: ago(60),
  by: "desk",
  ...x,
});

Deno.test("nodes: the session cap from memory, the container's limit first, an override wins", () => {
  assertEquals(memoryLimit("max\n", 32 * GiB), 32 * GiB);
  assertEquals(memoryLimit(String(8 * GiB), 32 * GiB), 8 * GiB);
  assertEquals(memoryLimit(null, 16 * GiB), 16 * GiB);
  assertEquals(sessionCap(32 * GiB), 20);
  assertEquals(sessionCap(8 * GiB), 4);
  assertEquals(sessionCap(2 * GiB), 1, "at least one");
  assertEquals(sessionCap(32 * GiB, 3), 3);
  assertEquals(sessionCap(32 * GiB, 0), 0, "zero: the owner closed it");
  assertEquals(sessionCap(32 * GiB, "lots"), 20, "junk is ignored");
});

Deno.test("nodes: the owner is present at an active graphical session that is not locked", () => {
  const s = (type: string, active: string, locked: string) => `Type=${type}\nActive=${active}\nLockedHint=${locked}\n`;
  assert(presentFrom([s("tty", "yes", "no"), s("wayland", "yes", "no")]));
  assert(!presentFrom([s("wayland", "yes", "yes")]), "locked");
  assert(!presentFrom([s("x11", "no", "no")]), "another seat's turn");
  assert(!presentFrom([s("tty", "yes", "no")]), "an ssh login is not the owner at the machine");
  assert(!presentFrom([]));
});

Deno.test("nodes: a node's name is its hostname, from the token or from the machine", () => {
  assertEquals(nodeNameOf("agents-multi su ownyt"), "ownyt");
  assertEquals(nodeNameOf("my laptop (old)"), "my-laptop-old-");
  assertEquals(nodeNameOf("../x"), "x");
  assertEquals(nodeNameOf("  "), "node");
});

Deno.test("nodes: remotes compare without credentials, scheme or .git", () => {
  const want = "git.example.com/me/site";
  assertEquals(normalRemote("git@git.example.com:me/site.git"), want);
  assertEquals(normalRemote("https://user:tok@git.example.com/me/site.git/"), want);
  assertEquals(normalRemote("https://git.example.com/Me/Site"), want);
  assertEquals(normalRemote("ssh://git@git.example.com:2222/me/site.git"), "git.example.com:2222/me/site");
});

Deno.test("nodes: placement takes a node that can, a server when the owner is away, then the most room", () => {
  const desk = node("desk", { running: 1 }), lap = node("lap", { running: 3 }), srv = node("srv", { headless: true });
  assertEquals(place(spec, [desk, lap, { ...srv, sandbox: false }], NOW), "desk", "a server without its sandbox");
  assertEquals(place(spec, [desk, lap, { ...srv, sandbox: true }], NOW), "srv", "the owner is away");
  assertEquals(
    place(spec, [{ ...desk, present: true }, lap, { ...srv, sandbox: true }], NOW),
    "srv",
    "with the owner present: the most room",
  );
  assertEquals(place(spec, [{ ...desk, present: true }, lap], NOW, "desk"), "lap", "never the node it left");
  assertEquals(place({ account: "home/claude" }, [desk, lap], NOW), null, "nobody has that login");
  assertEquals(place(spec, [{ ...desk, seen: ago(600) }], NOW), null, "offline");
  assertEquals(place(spec, [{ ...desk, running: 4 }], NOW), null, "full");
});

Deno.test("nodes: a silent node's running jobs are interrupted and proposed elsewhere; old ones lapse", () => {
  const nodes = [node("desk", { seen: ago(900) }), node("srv", { headless: true, sandbox: true })];
  const jobs = [
    job("j1", { spec: { ...spec, id: "nightly-1015-a1b" } }),
    job("j2"), // no run id: marked, not resumable
    job("j3", { node: "srv" }),
    job("j4", { status: "proposed", created: ago(25 * 3600) }),
    job("j5", { status: "accepted", expires: ago(1) }),
    job("j6", { spec: { ...spec, id: "x" } }),
    job("j7", { status: "proposed", parent: "j6", kind: "resume" }),
  ];
  const s = sweep(nodes, jobs, NOW);
  assertEquals(s.interrupted, ["j1", "j2", "j6"]);
  assertEquals(s.lapsed, ["j4", "j5"]);
  assertEquals(s.resume.map((r) => [r.parent.id, r.node]), [["j1", "srv"]], "j6 already has its proposal");
  const p = resumeOf(s.resume[0].parent, "srv", "r1", new Date(NOW));
  assertEquals([p.kind, p.status, p.node, p.parent, p.spec.from, p.spec.id], [
    "resume",
    "proposed",
    "srv",
    "j1",
    "desk",
    "nightly-1015-a1b",
  ]);
});

Deno.test("nodes: a spec is kept only with a name, a remote, a folder inside it and an action", () => {
  assertEquals(specErrors(spec), []);
  assertEquals(specErrors({ ...spec, path: "../etc" }), ["path"]);
  assertEquals(specErrors({ ...spec, path: "/abs" }), ["path"]);
  assertEquals(specErrors({ ...spec, id: "Bad Id" }), ["id"]);
  assertEquals(specErrors(null), ["name", "repo", "path", "action"]);
});

Deno.test("nodes: canonical JSON does not depend on key order", () => {
  assertEquals(
    canonical({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }),
    '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
  );
  assertEquals(canonical({ a: undefined, b: 1 }), '{"b":1}');
});

Deno.test("nodes: a job runs only with the owner's signature, for this node, in time, once", async () => {
  const vault = new Uint8Array(32).fill(7);
  const keys = await approvalKeys(vault);
  assertEquals((await approvalKeys(vault)).public, keys.public, "the same vault, the same key");
  const other = await approvalKeys(new Uint8Array(32).fill(8));
  const j = job("j1", { status: "accepted", node: "srv", expires: new Date(NOW + 3600_000).toISOString() });
  j.signature = await signJob(j, keys.sign);
  assertEquals(await verifyJob(j, keys.public, "srv", NOW, []), null);
  assertEquals(await verifyJob(j, other.public, "srv", NOW, []), "the signature is not the owner's");
  assertEquals(await verifyJob(j, keys.public, "desk", NOW, []), "it is for srv, not desk");
  assertEquals(await verifyJob(j, keys.public, "srv", NOW + 2 * 3600_000, []), "its approval expired");
  assertEquals(await verifyJob(j, keys.public, "srv", NOW, ["j1"]), "already run here");
  // the service changing anything the owner signed breaks it
  const moved = { ...j, spec: { ...j.spec, action: { kind: "agent", task: "rm -rf ~" } } };
  assertEquals(await verifyJob(moved, keys.public, "srv", NOW, []), "the signature is not the owner's");
  const later = { ...j, expires: new Date(NOW + 99 * 3600_000).toISOString() };
  assertEquals(await verifyJob(later, keys.public, "srv", NOW, []), "the signature is not the owner's");
  assertEquals(await verifyJob({ ...j, signature: undefined }, keys.public, "srv", NOW, []), "not signed");
  assertEquals(
    await verifyJob({ ...j, signature: "@@" }, keys.public, "srv", NOW, []),
    "the signature is not the owner's",
  );
  assertEquals(
    await verifyJob({ ...j, local: true }, keys.public, "srv", NOW, []),
    "a local job is not taken from the service",
  );
});
