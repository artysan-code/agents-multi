// node_f2_test.ts — a server paired from the console (ADR 0013, F2), from both ends: the server asking with its key
// and a new code as each expires, the console's preview and yes against the service's real pairing (apps/brain/
// pair.ts), the vault key sealed to the server's key and opened only there, the page's pure parts, the doctor's
// check, and the coordinator's node tools over a stand-in CLI.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { Client } from "npm:@modelcontextprotocol/sdk@1.32.1/client/index.js";
import { InMemoryTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/inMemory.js";
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { adoptVaultKey, loadPairKey, pairingId, pairMachine, pairServer, serverPairLines } from "../node/pair.ts";
import { claimServer, confirmServer, type ServerDeps, serverView } from "../console/servers.ts";
import { pairFindings } from "../doctor/checks/pair.ts";
import { stageOf, typedCode } from "../../ui/src/pages/servers/lib.ts";
import { nodeList, proposeArgs, registerNodeTools, type RunCli } from "../../../shared/mcp/agents/node-tools.ts";
import { keyFingerprint, newPairKey, sealTo } from "../../../shared/mcp/lib/seal.ts";
import { importKey, keyMatches, loadKey, seal } from "../../../shared/mcp/lib/vault.ts";
import type { NodeInfo } from "../../../shared/mcp/lib/nodes.ts";
import { Auth } from "../../brain/auth.ts";
import { masterKey, Users } from "../../brain/users.ts";
import { Pairings } from "../../brain/pair.ts";
import { sha256, totp } from "../../brain/crypto.ts";
import type { Service } from "../node/service.ts";

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

// ---------------------------------------------------------------- the server's side

Deno.test("f2: a server asks with its key, shows the fingerprint, and asks again when a code expires", async () => {
  const key = await newPairKey();
  const asked: unknown[] = [], shown: { code: string; fingerprint?: string }[] = [];
  let n = 0;
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      asked.push(JSON.parse(String(init.body)));
      n++;
      return Promise.resolve(
        json({ code: `AAAA-000${n}`, pairing: `secret-${n}`, expires: new Date(Date.now() + 1000).toISOString() }),
      );
    }
    // the first code expires unclaimed; the second is claimed, with a box
    return Promise.resolve(
      String(input).endsWith("secret-1") ? json({ state: "expired" }) : json({
        state: "done",
        token: "brain_node",
        url: "https://b.test",
        sealed: { v: 1, epk: "e", iv: "i", ct: "c" },
      }),
    );
  }) as typeof fetch;
  const r = await pairServer("https://b.test", "atlas-node", "linux", key, {
    fetcher,
    sleep: () => Promise.resolve(),
    show: (p) => void shown.push(p),
  });
  assert(r.ok);
  assertEquals(r.token, "brain_node");
  assertEquals(r.id, await pairingId("secret-2"));
  assert(r.sealed);
  assertEquals(asked, [
    { name: "atlas-node", platform: "linux", key: key.x },
    { name: "atlas-node", platform: "linux", key: key.x },
  ]);
  const fp = await keyFingerprint(key.x);
  assertEquals(shown.map((s) => [s.code, s.fingerprint]), [["AAAA-0001", fp], ["AAAA-0002", fp]]);
  // the service names the pairing by the same id (its stored hash of the secret)
  assertEquals(await pairingId("secret-2"), await sha256("secret-2"));
});

Deno.test("f2: a desktop's pairing is unchanged: no key, no id, no box", async () => {
  const fetcher = ((_: unknown, init?: RequestInit) =>
    Promise.resolve(
      init?.method === "POST"
        ? json({ code: "ABCD-2345", pairing: "s", expires: new Date(Date.now() + 1000).toISOString() })
        : json({ state: "done", token: "brain_x", url: "https://b.test" }),
    )) as typeof fetch;
  const r = await pairMachine("https://b.test", "desk", "linux", {
    fetcher,
    sleep: () => Promise.resolve(),
    show: () => {},
  });
  assertEquals(r, { ok: true, token: "brain_x" });
});

Deno.test("f2: the pairing key is made once, kept 0600, and the same after a restart", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const a = await loadPairKey(`${dir}/state/pair-key`);
    const b = await loadPairKey(`${dir}/state/pair-key`);
    assertEquals(a, b);
    assertEquals((await Deno.stat(`${dir}/state/pair-key`)).mode! & 0o777, 0o600);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("f2: what the server's log says: the code, the fingerprint to compare, the service", () => {
  const l = serverPairLines({
    code: "ABCD-2345",
    fingerprint: "ab12-cd34-ef56-7890",
    service: "https://b.test",
    expires: "2026-10-16T20:10:00Z",
  });
  assert(l.some((x) => x.includes("ABCD-2345")) && l.some((x) => x.includes("ab12-cd34-ef56-7890")));
  assert(l.some((x) => x.includes("https://b.test")) && l.some((x) => x.includes("Add a server")));
});

// ---------------------------------------------------------------- console → service → server, end to end

async function realService() {
  const db = new DatabaseSync(":memory:");
  const users = new Users(db, await masterKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))), false);
  const auth = new Auth(db, users, { url: "https://b.test" });
  const link = await users.invite("ann", "ann", "Italian");
  const inv = (await users.invitation(link))!;
  await users.accept(link, "una passphrase lunga", await totp(inv.totpSecret));
  const pairings = new Pairings(db, auth, users, "https://b.test");
  const calls: Record<string, unknown>[] = [];
  // the console's service, answered by the service's own pairing code, as account ann
  const svc: Service = {
    url: "https://b.test",
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const b = body as Record<string, unknown>;
      calls.push(b);
      if (method !== "POST" || path !== "/api/pair/claim") throw new Error(`unexpected ${method} ${path}`);
      return await pairings.claim("ann", b.code, b.confirm === true, { scope: b.scope, sealed: b.sealed }) as T;
    },
  };
  return { pairings, auth, svc, calls };
}

Deno.test("f2: the console previews, seals the vault key to the server's key on the owner's yes; the server opens it", async () => {
  const { pairings, auth, svc, calls } = await realService();
  const key = await newPairKey();
  const p = await pairings.create("atlas-node", "linux", key.x);
  const vault = crypto.getRandomValues(new Uint8Array(32));
  const deps: ServerDeps = { svc: () => Promise.resolve(svc), vaultKey: () => Promise.resolve(vault) };
  const seen = await claimServer(p.code, deps);
  assert(seen.ok);
  assertEquals(seen.node, "atlas-node");
  assertEquals(seen.fingerprint, await keyFingerprint(key.x));
  // the page gets the fingerprint, never the public key, the pairing's id or anything secret
  assert(!("publicKey" in seen) && !("id" in seen));
  const yes = await confirmServer(p.code, seen.fingerprint, true, deps);
  assertEquals(yes, { ok: true, node: "atlas-node", sealed: true });
  // what crossed to the service: the box, never the vault key
  assert(!JSON.stringify(calls).includes(btoa(String.fromCharCode(...vault))));
  const done = await pairings.poll(p.pairing);
  assert(done.state === "done" && done.sealed);
  const who = await auth.caller(
    new Request("https://b.test/mcp", { headers: { authorization: `Bearer ${done.token}` } }),
  );
  assertEquals(who?.scope, "node");
  // the server opens it with its key and keeps it as a server keeps the vault key
  const dir = await Deno.makeTempDir();
  Deno.env.set("AGENTS_MULTI_VAULT", `${dir}/vault`);
  Deno.env.set("AGENTS_MULTI_VAULT_KEY_FILE", `${dir}/state/vault-key`);
  try {
    // the vault still on its way: kept as it came
    assertEquals(await adoptVaultKey(done.sealed, key, await pairingId(p.pairing)), "kept");
    assertEquals((await loadKey()).raw, vault);
    assertEquals((await Deno.stat(`${dir}/state/vault-key`)).mode! & 0o777, 0o600);
    // the vault here: checked against it first, and a key that does not open it is refused
    await Deno.mkdir(`${dir}/vault`, { recursive: true });
    const check = await seal(await importKey(vault), "key-check", "claude-multi vault");
    await Deno.writeTextFile(`${dir}/vault/key-check.json`, JSON.stringify(check));
    assertEquals(await adoptVaultKey(done.sealed, key, await pairingId(p.pairing)), "checked");
    assert(await keyMatches(await loadKey()));
    const wrong = await sealTo(new Uint8Array(32).fill(1), key.x, "id-x");
    await assertRejects(() => adoptVaultKey(wrong, key, "id-x"), Error, "does not open");
  } finally {
    Deno.env.delete("AGENTS_MULTI_VAULT");
    Deno.env.delete("AGENTS_MULTI_VAULT_KEY_FILE");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("f2: a fingerprint that is not the one compared sends nothing; a desktop's code is sent to the web app", async () => {
  const { pairings, svc, calls } = await realService();
  const key = await newPairKey();
  const p = await pairings.create("atlas-node", "linux", key.x);
  const deps: ServerDeps = { svc: () => Promise.resolve(svc), vaultKey: () => Promise.resolve(new Uint8Array(32)) };
  const r = await confirmServer(p.code, "0000-0000-0000-0000", true, deps);
  assert(!r.ok && r.message.includes("not the one you compared"));
  assert(calls.every((c) => c.confirm !== true), "no confirm was sent");
  assertEquals(await pairings.poll(p.pairing), { state: "waiting" });
  const d = await pairings.create("laptop", "linux");
  const c = await claimServer(d.code, deps);
  assert(!c.ok && c.message.includes("desktop"));
  const off = await claimServer(p.code, { ...deps, svc: () => Promise.resolve("no brain account") });
  assertEquals(off, { ok: false, message: "no brain account" });
});

Deno.test("f2: a service that shows the real fingerprint but hands over its own key gets nothing sealed", async () => {
  const { pairings, svc } = await realService();
  const key = await newPairKey();
  const theirs = await newPairKey();
  const p = await pairings.create("atlas-node", "linux", key.x);
  const calls: Record<string, unknown>[] = [];
  // the preview keeps the container's fingerprint in `key` and swaps the key the box would be sealed to
  const hostile: Service = {
    url: svc.url,
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      calls.push(body as Record<string, unknown>);
      const r = await svc.call<{ preview?: Record<string, unknown> }>(method, path, body);
      return (r.preview ? { ...r, preview: { ...r.preview, publicKey: theirs.x } } : r) as T;
    },
  };
  const deps: ServerDeps = { svc: () => Promise.resolve(hostile), vaultKey: () => Promise.resolve(new Uint8Array(32)) };
  const seen = await claimServer(p.code, deps);
  assert(seen.ok);
  // what the owner compares is the key the vault would go to: it does not match the container's log
  assert(seen.fingerprint !== await keyFingerprint(key.x));
  const r = await confirmServer(p.code, await keyFingerprint(key.x), true, deps);
  assert(!r.ok && r.message.includes("not the one you compared"));
  assert(calls.every((c) => c.confirm !== true), "no confirm was sent");
});

// ---------------------------------------------------------------- the page, the doctor

Deno.test("f2: the page reads a typed code as the service does, and says where a server stands", () => {
  assertEquals(typedCode(" abcd 2345 "), "ABCD-2345");
  assertEquals(typedCode("OIL0-1111"), "0110-1111");
  assertEquals(typedCode("ABCU-2345"), null);
  assertEquals(typedCode("ABC"), null);
  assertEquals(stageOf({ known: false }), "unseen");
  assertEquals(stageOf({ known: true, online: false }), "offline");
  assertEquals(stageOf({ known: true, online: true, waits: ["x"], sandbox: true }), "waiting");
  assertEquals(stageOf({ known: true, online: true, waits: [], sandbox: false }), "waiting");
  assertEquals(stageOf({ known: true, online: true, waits: [], sandbox: true }), "ready");
  const now = Date.parse("2026-10-16T20:00:00Z");
  const row = {
    name: "atlas",
    seen: "2026-10-16T19:59:30Z",
    kind: "server",
    gitKey: "ssh-ed25519 AAAA x",
    waits: ["w"],
    accounts: ["work/claude"],
    sandbox: true,
  } as unknown as NodeInfo;
  assertEquals(serverView([row], "atlas", now), {
    known: true,
    online: true,
    seen: row.seen,
    server: true,
    gitKey: "ssh-ed25519 AAAA x",
    waits: ["w"],
    accounts: ["work/claude"],
    sandbox: true,
  });
  assertEquals(serverView([row], "other", now), { known: false });
});

Deno.test("f2: the doctor wants the pairing key the user's alone, and gone once paired", () => {
  assertEquals(pairFindings({ keyMode: null, paired: true }), []);
  assertEquals(pairFindings({ keyMode: 0o600, paired: false })[0].status, "ok");
  assertEquals(pairFindings({ keyMode: 0o644, paired: false })[0].status, "fail");
  assertEquals(pairFindings({ keyMode: 0o600, paired: true })[0].status, "warn");
});

// ---------------------------------------------------------------- the coordinator's tools

const NODES = {
  now: "2026-10-16T20:00:00Z",
  jobs: [],
  nodes: [
    {
      name: "atlas",
      seen: "2026-10-16T19:59:50Z",
      headless: true,
      kind: "server",
      running: 1,
      cap: 4,
      accounts: ["work/claude"],
      sandbox: true,
      present: false,
    },
    {
      name: "desk",
      seen: "2026-10-16T18:00:00Z",
      headless: false,
      running: 0,
      cap: 2,
      accounts: [],
      sandbox: null,
      present: true,
    },
  ],
};

Deno.test("f2: node_list shows each node and what it takes; node_propose only proposes, through the CLI", async () => {
  const ran: string[][] = [];
  const run: RunCli = (args) => {
    ran.push(args);
    if (args[1] === "list") return Promise.resolve({ code: 0, out: JSON.stringify(NODES), err: "" });
    if (args.includes("nope")) return Promise.resolve({ code: 1, out: "", err: "agents nodes: no routine nope here" });
    return Promise.resolve({
      code: 0,
      out: JSON.stringify({
        job: { id: "j-1", kind: "routine", spec: { name: "nightly" }, node: "", status: "proposed" },
      }),
      err: "",
    });
  };
  const server = new McpServer({ name: "agents", version: "0" });
  registerNodeTools(server, run);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { error: !!r.isError, text: r.content[0].text };
  };
  const listed = JSON.parse((await call("node_list", {})).text).nodes;
  assertEquals(listed.map((n: { name: string; online: boolean; takes: string }) => [n.name, n.online, n.takes]), [
    ["atlas", true, "work"],
    ["desk", false, "offline"],
  ]);
  assertEquals(listed[0].sessions, { running: 1, cap: 4 });
  const p = JSON.parse((await call("node_propose", { routine: "nightly", why: "the desk is off tonight" })).text);
  assertEquals(p.job, { id: "j-1", kind: "routine", name: "nightly", node: null, status: "proposed" });
  assert(p.waits.includes("owner's yes"));
  assertEquals(ran.at(-1), ["nodes", "propose", "nightly", "--why", "the desk is off tonight", "--json"]);
  const bad = await call("node_propose", { routine: "nope", why: "because" });
  assert(bad.error && bad.text.includes("no routine nope"));
  assert((await call("node_propose", { why: "neither" })).error);
  // no tool that accepts, declines or stops
  const names = (await client.listTools()).tools.map((t: { name: string }) => t.name).sort();
  assertEquals(names, ["node_list", "node_propose"]);
});

Deno.test("f2: the proposal's arguments: a routine or a run, the node when named, always why", () => {
  assertEquals(proposeArgs({ run: "r-1", node: "atlas", why: "w" }), [
    "nodes",
    "propose",
    "--run",
    "r-1",
    "--node",
    "atlas",
    "--why",
    "w",
    "--json",
  ]);
  let threw = 0;
  for (const p of [{ why: "w" }, { routine: "a", run: "b", why: "w" }]) {
    try {
      proposeArgs(p);
    } catch {
      threw++;
    }
  }
  assertEquals(threw, 2);
  assertEquals(nodeList([], 0, []), []);
});
