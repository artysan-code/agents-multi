// scope_test.ts — the `node` token scope (ADR 0013, F2): what a server's token may reach and what it may not, the
// gate failing closed, the tokens made before it staying a machine's, a server's pairing (its key's fingerprint, the
// vault key sealed to it, which the service keeps and cannot open, a node token handed over once), and the brain's
// tools narrowed to the projects and the notes.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { Client } from "npm:@modelcontextprotocol/sdk@1.32.1/client/index.js";
import { InMemoryTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/inMemory.js";
import { ACCOUNTS_MIGRATIONS, Auth, NODE_ROUTES, nodeOwnRefusal, scopeAllows, serverAnnounceRefusal } from "../auth.ts";
import { migrate } from "../migrate.ts";
import { masterKey, Users } from "../users.ts";
import { PairError, Pairings } from "../pair.ts";
import { sha256, totp } from "../crypto.ts";
import { Store } from "../store.ts";
import { brainServer, narrowScope, NODE_REFUSED } from "../tools.ts";
import { brainView, listedTools, MCP_HEADERS, TOOLS_LIST } from "../../../shared/mcp/lib/headless.ts";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/webStandardStreamableHttp.js";
import { cleanAnnounce, Fleet } from "../fleet.ts";
import { keyFingerprint, newPairKey, openSealed, sealTo } from "../../../shared/mcp/lib/seal.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

// ---------------------------------------------------------------- the gate

/** What a server node does (apps/cli/node): every one of these must pass. */
const NODE_MAY: [string, string][] = [
  ["PUT", "/api/node"],
  ["GET", "/api/node/turns"],
  ["POST", "/api/turns/t-1/events"],
  ["POST", "/api/turns/t-1/done"],
  ["GET", "/api/turns/t-1/audio"],
  ["GET", "/api/node/answers"],
  ["POST", "/api/node/answers"],
  ["PUT", "/api/node/requests"],
  ["PUT", "/api/node/runs"],
  ["POST", "/api/jobs"],
  ["POST", "/api/jobs/j-1"],
  ["GET", "/api/tasks"],
  ["GET", "/api/tasks/t-20261016-abc123"],
  ["PUT", "/api/tasks/t-20261016-abc123"],
  ["GET", "/api/passkeys"],
  ["DELETE", "/api/nodes/atlas-node"],
  ["POST", "/mcp"],
];

/** What it must never reach: the owner's chats, settings, other machines, the whole brain, pairing. */
const NODE_MAY_NOT: [string, string][] = [
  ["GET", "/api/nodes"],
  ["GET", "/api/chats"],
  ["POST", "/api/chats"],
  ["GET", "/api/chats/c-1"],
  ["GET", "/api/chats/c-1/events"],
  ["POST", "/api/turns/t-1/cancel"],
  ["GET", "/api/settings/orchestrator"],
  ["PUT", "/api/settings/orchestrator"],
  ["GET", "/api/waiting"],
  ["POST", "/api/waiting/w-1"],
  ["POST", "/api/passkeys"],
  ["POST", "/api/passkeys/options"],
  ["POST", "/api/passkeys/k-1/endorse"],
  ["DELETE", "/api/passkeys/k-1"],
  ["POST", "/api/pair/claim"],
  ["GET", "/api/brain/pages"],
  ["GET", "/api/brain/page"],
  ["GET", "/api/brain/search"],
  ["GET", "/api/brain/state"],
  ["GET", "/backup"],
  ["GET", "/backup/state"],
  ["POST", "/api/push/subscribe"],
  ["GET", "/api/push/key"],
  ["GET", "/api/runs"],
  ["GET", "/api/runs/events"],
  ["POST", "/api/runs/desk/r-1/stop"],
  ["DELETE", "/api/tasks/t-20261016-abc123"],
  ["GET", "/api/node"],
  ["GET", "/api/node/requests"],
  ["GET", "/api/node/runs"],
  ["GET", "/api/nodes/atlas-node"],
  ["DELETE", "/api/jobs/j-1"],
  ["GET", "/api/anything-new"],
];

Deno.test("scope: a node token reaches its own routes, the tasks and the MCP endpoint", () => {
  for (const [m, p] of NODE_MAY) assert(scopeAllows("node", m, p), `${m} ${p}`);
});

Deno.test("scope: a node token reaches nothing of the owner's beyond them", () => {
  for (const [m, p] of NODE_MAY_NOT) assert(!scopeAllows("node", m, p), `${m} ${p}`);
});

Deno.test("scope: the scopes from before F2 keep what they had; one the gate does not know reaches nothing", () => {
  for (const s of ["machine", "brain", "web"]) {
    for (const [m, p] of [...NODE_MAY, ...NODE_MAY_NOT]) assert(scopeAllows(s, m, p), `${s} ${m} ${p}`);
  }
  for (const s of ["admin", "", undefined, null, "NODE", 1]) {
    for (const [m, p] of [...NODE_MAY, ...NODE_MAY_NOT]) assert(!scopeAllows(s, m, p), `${String(s)} ${m} ${p}`);
  }
  // the allowlist is anchored: a longer path does not slip through
  for (const [, re] of NODE_ROUTES) assert(re.source.startsWith("^") && re.source.endsWith("$"), re.source);
});

Deno.test("scope: a server announces with a node token only; a desktop keeps its machine token", () => {
  // what a leaked server credential reads must be a node's (#6): a headless announce with a wider token is refused
  for (const scope of ["machine", "brain", "web", undefined]) {
    assert(serverAnnounceRefusal(scope, { headless: true, platform: "linux" }), String(scope));
  }
  assertEquals(serverAnnounceRefusal("node", { headless: true }), null);
  assertEquals(serverAnnounceRefusal("machine", { headless: false }), null);
  assertEquals(serverAnnounceRefusal("machine", {}), null);
  assertEquals(serverAnnounceRefusal("machine", null), null);
  assertEquals(serverAnnounceRefusal("machine", { headless: "yes" }), null);
  // the doctor's node.scope asks GET /api/nodes with the server's token: a node's is refused, a machine's is not
  assert(!scopeAllows("node", "GET", "/api/nodes"));
  assert(scopeAllows("machine", "GET", "/api/nodes"));
});

Deno.test("scope: past the gate, a node acts only on its own jobs, only claims and reports, forgets only itself", () => {
  const jobNode = (id: string) => ({ "j-mine": "atlas", "j-other": "desk" } as Record<string, string>)[id] ?? null;
  const r = (method: string, path: string, op?: string) => nodeOwnRefusal({ method, path, me: "atlas", op, jobNode });
  assertEquals(r("POST", "/api/jobs/j-mine", "claim"), null);
  assertEquals(r("POST", "/api/jobs/j-mine", "report"), null);
  assertEquals(r("GET", "/api/jobs/j-mine"), null);
  assert(r("POST", "/api/jobs/j-mine", "accept"));
  assert(r("POST", "/api/jobs/j-mine", "decline"));
  assert(r("POST", "/api/jobs/j-mine"));
  assert(r("POST", "/api/jobs/j-other", "claim"));
  assert(r("GET", "/api/jobs/j-other"));
  assertEquals(r("POST", "/api/jobs/j-none", "claim"), null); // the fleet answers 404
  assertEquals(r("DELETE", "/api/nodes/atlas"), null);
  assert(r("DELETE", "/api/nodes/desk"));
  assert(r("DELETE", "/api/nodes/%E0%A4%A"));
  assertEquals(r("PUT", "/api/node"), null);
});

// ---------------------------------------------------------------- the tokens

async function accounts() {
  let now = Date.parse("2026-10-16T20:00:00Z");
  const db = new DatabaseSync(":memory:");
  const users = new Users(db, await masterKey(KEY), false);
  const auth = new Auth(db, users, { url: "https://b.test" });
  for (const id of ["ann", "bob"]) {
    const link = await users.invite(id, id, "Italian");
    const inv = (await users.invitation(link))!;
    assert(typeof await users.accept(link, "una passphrase lunga", await totp(inv.totpSecret)) !== "string");
  }
  const pairings = new Pairings(db, auth, users, "https://b.test", () => now);
  return { db, auth, users, pairings, tick: (ms: number) => (now += ms) };
}
const bearer = (t: string) => new Request("https://b.test/mcp", { headers: { authorization: `Bearer ${t}` } });

Deno.test("scope: a token made before the column is a machine's; a node token says so; a strange one is kept", async () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, ACCOUNTS_MIGRATIONS.slice(0, 2)); // a database as the service left it before F2
  const users = new Users(db, await masterKey(KEY), false);
  const link = await users.invite("ann", "ann", "Italian");
  const inv = (await users.invitation(link))!;
  await users.accept(link, "una passphrase lunga", await totp(inv.totpSecret));
  db.prepare("insert into tokens (hash, user, kind, name, created) values (?, 'ann', 'personal', 'fisso', ?)").run(
    await sha256("brain_old"),
    new Date().toISOString(),
  );
  const auth = new Auth(db, users, { url: "https://b.test" }); // migrates in place
  assertEquals(await auth.caller(bearer("brain_old")), { user: "ann", label: "token:fisso", scope: "machine" });
  const n = await auth.createPersonal("ann", "atlas", "node");
  assertEquals((await auth.caller(bearer(n)))?.scope, "node");
  db.prepare("update tokens set scope = 'root' where hash = ?").run(await sha256(n));
  assertEquals((await auth.caller(bearer(n)))?.scope as string, "root");
  assert(!scopeAllows("root", "POST", "/mcp"));
});

// ---------------------------------------------------------------- a server's pairing

Deno.test("scope: a server pairs with its key: fingerprint to compare, the vault key sealed, a node token once", async () => {
  const { pairings, auth, db } = await accounts();
  const key = await newPairKey();
  const p = await pairings.create("atlas-node", "linux", key.x);
  // the preview: which machine, and its key's fingerprint, the public key and the pairing's id to seal to
  const seen = await pairings.claim("ann", p.code);
  assert("preview" in seen);
  assertEquals(seen.preview.kind, "server");
  assertEquals(seen.preview.key, await keyFingerprint(key.x));
  assert(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/.test(seen.preview.key!));
  assertEquals(seen.preview.publicKey, key.x);
  assertEquals(seen.preview.id, await sha256(p.pairing)); // the poll secret's hash, never the secret
  assert(!JSON.stringify(seen).includes(p.pairing));
  // the owner's console seals the vault key and confirms
  const vaultKey = crypto.getRandomValues(new Uint8Array(32));
  const sealed = await sealTo(vaultKey, seen.preview.publicKey!, seen.preview.id!);
  assertEquals(await pairings.claim("ann", p.code, true, { scope: "node", sealed }), {
    node: "atlas-node",
    kind: "server",
  });
  // what the service holds: the box, opaque; never the vault key
  const row = JSON.stringify(db.prepare("select * from pairings").all());
  assert(row.includes(sealed.ct) && !row.includes(btoa(String.fromCharCode(...vaultKey))));
  const done = await pairings.poll(p.pairing);
  assert(done.state === "done");
  assertEquals((await auth.caller(bearer(done.token)))?.scope, "node");
  assertEquals(await openSealed(done.sealed!, key, await sha256(p.pairing)), vaultKey);
  // once: the row and its box are gone
  assertEquals(await pairings.poll(p.pairing), { state: "expired" });
  assertEquals((db.prepare("select count(*) n from pairings").get() as { n: number }).n, 0);
});

Deno.test("scope: a server paired without a sealed key gets its token alone; a desktop's pairing stays a machine's", async () => {
  const { pairings, auth } = await accounts();
  const key = await newPairKey();
  const s = await pairings.create("srv", "linux", key.x);
  await pairings.claim("ann", s.code, true);
  const done = await pairings.poll(s.pairing);
  assert(done.state === "done" && !("sealed" in done));
  assertEquals((await auth.caller(bearer(done.token)))?.scope, "node");
  const d = await pairings.create("laptop", "linux");
  const pv = await pairings.claim("ann", d.code);
  assert("preview" in pv && !pv.preview.key && !pv.preview.kind);
  await pairings.claim("ann", d.code, true);
  const dd = await pairings.poll(d.pairing);
  assert(dd.state === "done");
  assertEquals((await auth.caller(bearer(dd.token)))?.scope, "machine");
});

Deno.test("scope: a pairing refuses a bad key, a sealed key for a desktop, a scope that is not its own, a junk box", async () => {
  const { pairings } = await accounts();
  await assertRejects(() => pairings.create("srv", "linux", "short"), PairError, "public key");
  await assertRejects(() => pairings.create("srv", "linux", 42), PairError, "public key");
  const key = await newPairKey();
  const box = await sealTo(new Uint8Array(32), key.x, "id");
  const d = await pairings.create("laptop", "linux");
  await assertRejects(() => pairings.claim("ann", d.code, true, { sealed: box }), PairError, "only a server");
  await assertRejects(() => pairings.claim("ann", d.code, true, { scope: "node" }), PairError, "scope machine");
  const s = await pairings.create("srv", "linux", key.x);
  await assertRejects(() => pairings.claim("ann", s.code, true, { scope: "machine" }), PairError, "scope node");
  await assertRejects(() => pairings.claim("ann", s.code, true, { sealed: { v: 1, epk: "x" } }), PairError, "sealed");
  // none of these bound the code: it still pairs
  assertEquals((await pairings.claim("ann", s.code, true, { sealed: box }) as { node: string }).node, "srv");
});

Deno.test("seal: the box opens only with the node's key and for its pairing; a changed box does not open", async () => {
  const node = await newPairKey(), other = await newPairKey();
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const box = await sealTo(raw, node.x, "pairing-1");
  assertEquals(await openSealed(box, node, "pairing-1"), raw);
  await assertRejects(() => openSealed(box, other, "pairing-1"));
  await assertRejects(() => openSealed(box, node, "pairing-2"));
  const ct = box.ct.slice(0, -2) + (box.ct.endsWith("AA") ? "BB" : "AA");
  await assertRejects(() => openSealed({ ...box, ct }, node, "pairing-1"));
  // a key swapped by the service: the console seals to the swapped key, and the node cannot open it
  const swapped = await sealTo(raw, other.x, "pairing-1");
  await assertRejects(() => openSealed(swapped, node, "pairing-1"));
  assert((await keyFingerprint(node.x)) !== (await keyFingerprint(other.x)));
});

// ---------------------------------------------------------------- the brain's tools, narrowed

async function tools(scope?: string) {
  const store = new Store(":memory:");
  store.write("io/chi-sono.md", "# Chi sono\n\nIl ritratto.\n", "t");
  store.write("persone/mario.md", "# Mario\n\nUn amico, vedi [[progetti/app]].\n", "t");
  store.write("clienti/acme.md", "# Acme\n\nIl cliente.\n", "t");
  store.write("inbox/inbox.md", "# Inbox\n\nDa sistemare.\n- 2026-10-16 10:00 una cosa\n", "t");
  store.write("progetti/app.md", "# App\n\nIl progetto app, con [[persone/mario]].\n", "t");
  store.write("note/deploy.md", "# Deploy\n\nCome si fa il deploy dell'app.\n", "t");
  const server = brainServer({
    store,
    embed: { url: "http://127.0.0.1:9", model: "x" },
    by: () => "t",
    changed: () => {},
  }, scope);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] };
    return { error: !!r.isError, text: r.content.map((c) => c.text).join("") };
  };
  return { client, call, server, instructions: client.getInstructions() ?? "" };
}

Deno.test("scope: a node's brain tools read only projects and notes, write only the diary line", async () => {
  const { client, call, instructions } = await tools("node");
  const names = (await client.listTools()).tools.map((t: { name: string }) => t.name);
  for (const n of ["brain_search", "brain_read", "brain_list", "brain_append", "tasks_list"]) {
    assert(names.includes(n), n);
  }
  for (
    const n of [
      "brain_write",
      "brain_edit",
      "brain_delete",
      "brain_move",
      "brain_restore",
      "brain_history",
      "brain_inbox_clear",
      "brain_check",
    ]
  ) {
    assert(!names.includes(n), n);
  }
  assert(!instructions.includes("Il ritratto"), "io/ is not in a node's instructions");
  assert(!(await call("brain_read", { path: "progetti/app" })).error);
  assert(!(await call("brain_read", { path: "note/deploy.md" })).error);
  for (const p of ["io/chi-sono", "persone/mario", "clienti/acme", "inbox/inbox", "mario", "chi-sono"]) {
    const r = await call("brain_read", { path: p });
    assert(r.error && r.text.includes("out of reach"), p);
  }
  assert((await call("brain_read", { path: "io/chi-sono", rev: 1 })).error);
  // the pages linking here, only the readable ones
  assert(!(await call("brain_read", { path: "note/deploy" })).text.includes("persone/"));
  const app = JSON.parse((await call("brain_read", { path: "progetti/app" })).text);
  assert(!app.links.back.some((x: string) => x.startsWith("persone/")));
  for (const f of ["io", "persone", "clienti", "inbox", "diario"]) {
    assert((await call("brain_list", { folder: f })).error, f);
  }
  const all = JSON.parse((await call("brain_list", {})).text).documents.map((d: { path: string }) => d.path).sort();
  assertEquals(all, ["note/deploy.md", "progetti/app.md"]);
  const found = JSON.parse((await call("brain_search", { query: "app" })).text).results.map((r: { path: string }) =>
    r.path
  );
  assert(found.length > 0 && found.every((p: string) => p.startsWith("progetti/") || p.startsWith("note/")), found);
  assert((await call("brain_append", { where: "inbox", text: "una cosa" })).error);
});

Deno.test("scope: the whole view is unchanged for the owner's tokens; a scope nobody knows is narrowed", async () => {
  for (const s of [undefined, "machine", "brain", "web"]) {
    const { client, call } = await tools(s);
    assert((await client.listTools()).tools.some((t: { name: string }) => t.name === "brain_write"), String(s));
    assert(!(await call("brain_read", { path: "io/chi-sono" })).error, String(s));
  }
  assert(narrowScope("node") && narrowScope("root") && narrowScope(""));
  assert(!narrowScope(undefined) && !narrowScope("machine"));
});

// ---------------------------------------------------------------- the node row

Deno.test("scope: a node token's announce makes its row a server's, with its git key and what it waits for", () => {
  const db = new Store(":memory:").db;
  const pub = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKtnwFllg1AiKlrNYpqXUQ8pU3NrsxDbQfbRb6Fge0pp agents-node@atlas";
  const a = cleanAnnounce({
    platform: "linux",
    headless: true,
    kind: "server", // a node cannot say it: the service sets it from the token
    gitKey: pub,
    waits: ["Claude, work: no token in the vault", 7, "x".repeat(500)],
  });
  assertEquals(a.gitKey, pub);
  assertEquals(a.waits, ["Claude, work: no token in the vault", "x".repeat(200)]);
  assert(!("kind" in a));
  assertEquals(cleanAnnounce({ gitKey: "ssh-rsa AAAA; rm -rf /" }).gitKey, undefined);
  new Fleet(db, undefined, undefined, "server").announce("atlas", a);
  new Fleet(db).announce("desk", cleanAnnounce({ platform: "linux" }));
  const rows = new Fleet(db).nodes();
  assertEquals(rows.find((n) => n.name === "atlas")?.kind, "server");
  assertEquals(rows.find((n) => n.name === "atlas")?.gitKey, pub);
  assertEquals(rows.find((n) => n.name === "desk")?.kind, undefined);
});

Deno.test("scope: a node calling a tool its view leaves out is told why, not «not found»", async () => {
  const { call } = await tools("node");
  for (const n of NODE_REFUSED) {
    const r = await call(n, { path: "progetti/app.md", body: "x", find: "a", replace: "b", from: "a", to: "b" });
    assert(r.error, n);
    assert(r.text.includes(`${n} is not available to a server node`) && r.text.includes("progetti/"), r.text);
  }
  // a tool nobody has is still the SDK's answer; a page out of reach is refused before it is looked up
  assert((await call("brain_nothing", {})).text.includes("not found"));
  const missing = await call("brain_read", { path: "io/does-not-exist" });
  assert(missing.error && missing.text.includes("out of reach"), missing.text);
  assert((await call("brain_read", { path: "IO/chi-sono" })).text.includes("out of reach"));
  // the owner's tokens keep the whole view, and its tools answer
  const owner = await tools("machine");
  assert(!(await owner.call("brain_history", { path: "progetti/app.md" })).error);
});

Deno.test("scope: the doctor's tools/list over HTTP tells a node's view from the owner's", async () => {
  const store = new Store(":memory:");
  const ctx = { store, embed: { url: "http://127.0.0.1:9", model: "x" }, by: () => "t", changed: () => {} };
  const ask = async (scope: string) => {
    const server = brainServer(ctx, scope);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const r = await transport.handleRequest(
      new Request("http://b.test/mcp", { method: "POST", headers: MCP_HEADERS, body: JSON.stringify(TOOLS_LIST) }),
    );
    assertEquals(r.status, 200);
    return brainView(listedTools(await r.text()));
  };
  assertEquals(await ask("node"), "node");
  assertEquals(await ask("machine"), "whole");
});
