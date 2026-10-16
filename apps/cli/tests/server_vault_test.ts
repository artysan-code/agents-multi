// Tests for the vault a server node gets instead of the owner's (ADR 0015): the selection, the sync between two
// real vault folders (a key file, no keyring), the key that tells the two kinds apart, what a node reads from it.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const tmp = await Deno.makeTempDir();
const ownerDir = `${tmp}/owner`, serverDir = `${tmp}/server`, config = `${tmp}/config`;
await Deno.mkdir(config, { recursive: true });
Deno.env.set("AGENTS_MULTI_VAULT", ownerDir);
Deno.env.set("AGENTS_MULTI_SERVER_VAULT", serverDir);
Deno.env.set("AGENTS_MULTI_VAULT_KEY_FILE", `${tmp}/vault-key`);
Deno.env.set("AGENTS_MULTI_CONFIG", config);

const v = await import("../../../shared/mcp/lib/vault.ts");
const sv = await import("../node/server-vault.ts");
const { cleanNodeConfig } = await import("../../../shared/mcp/lib/headless.ts");
const { nodeFindings } = await import("../doctor/checks/node.ts");
const { serverVaultFinding } = await import("../doctor/checks/vault.ts");
const { approvalKey } = await import("../node/facts.ts");
const { approvalKeys } = await import("../../../shared/mcp/lib/nodes.ts");

const entry = (service: string, account: string, value = "x", field = "token") => ({
  service,
  account,
  field,
  value,
  updatedAt: "2026-10-16T00:00:00Z",
});
const names = (es: { service: string; account: string }[]) => es.map((e) => `${e.service}/${e.account}`).sort();

Deno.test("selection: Claude's tokens and what a node reads, the listed services, never the brain's", () => {
  assert(sv.selected({ service: "claude", account: "work" }));
  assert(sv.selected({ service: "passkey-revocations", account: "abc" }));
  assert(sv.selected({ service: "seed", account: "git.example.me/me/app" }));
  assert(!sv.selected({ service: "cloudflare", account: "main" }));
  assert(sv.selected({ service: "cloudflare", account: "main" }, ["cloudflare/main"]));
  assert(!sv.selected({ service: "cloudflare", account: "other" }, ["cloudflare/main"]));
  // listed or not, the brain's and the server key never go
  assert(!sv.selected({ service: "brain", account: "brain" }, ["brain/brain"]));
  assert(!sv.selected({ service: "server-vault", account: "key" }, ["server-vault/key"]));
});

Deno.test("plan: writes what is new or changed, removes what is no longer selected, ignores tombstones", () => {
  const owner = [
    entry("claude", "work", "t1"),
    entry("claude", "personal", "t2"),
    entry("brain", "brain", "b"),
    entry("cloudflare", "main", "c"),
    { ...entry("claude", "old", "gone"), deleted: true },
  ];
  const server = [
    entry("claude", "work", "t1"), // same
    entry("claude", "personal", "OLD"), // changed
    entry("brain", "brain", "b"), // must not be there
    entry("github", "x", "g"), // no longer selected
    { ...entry("claude", "dead", ""), deleted: true }, // a tombstone is nothing
  ];
  const p = sv.planSync(owner, server);
  assertEquals(names(p.write), ["claude/personal"]);
  assertEquals(names(p.remove), ["brain/brain", "github/x"]);
  assertEquals(names(sv.planSync(owner, server, ["cloudflare/main"]).write), ["claude/personal", "cloudflare/main"]);
  assertEquals(sv.summary(sv.planSync([], [])), "server vault: already up to date");
});

Deno.test("summary prints names, never values", () => {
  const line = sv.summary({
    write: [entry("claude", "work", "sk-ant-oat01-SECRET")],
    remove: [entry("github", "x", "tok")],
  });
  assertEquals(line, "server vault: +claude/work -github/x");
});

Deno.test("nodes.json serverServices: valid pairs only, never the brain's", () => {
  const c = cleanNodeConfig({
    serverServices: ["cloudflare/main", "brain/brain", "Brain/x", "nope", "a/b/c", 5, "cloudflare/main"],
  });
  assertEquals(c.serverServices, ["cloudflare/main"]);
  assertEquals(cleanNodeConfig({}).serverServices, undefined);
});

Deno.test("sync: a server vault of its own, under its own key, with the selection and nothing else", async () => {
  await v.initVault("file");
  await v.setSecret("claude", "work", "sk-ant-oat01-aaaaaaaaaaaaaaaaaaaaaaaa", "oauth-token");
  await v.setSecret("brain", "brain", "brain-token");
  await v.setSecret("cloudflare", "main", "cf-token");
  await v.setSecret("passkey-revocations", "cred1", "2026-10-16");
  await Deno.writeTextFile(
    `${config}/nodes.json`,
    JSON.stringify({ serverServices: ["cloudflare/main", "brain/brain"] }),
  );

  const dry = await sv.syncServerVault(true);
  assert(dry.write.length >= 3);
  assert(!v.hasVault(serverDir), "a dry run makes nothing");

  const r = await sv.syncServerVault();
  assert(r.created);
  assertEquals(names(r.write), ["approval/owner", "claude/work", "cloudflare/main", "passkey-revocations/cred1"]);
  const skey = (await sv.serverKey())!;
  const ownerKey = await v.loadKey();
  // two vaults, two keys, two kinds: neither key opens the other's folder
  assertEquals(await v.vaultKind(ownerKey, ownerDir), "owner");
  assertEquals(await v.vaultKind(skey, serverDir), "server");
  assertEquals(await v.vaultKind(ownerKey, serverDir), "foreign");
  assertEquals(await v.vaultKind(skey, ownerDir), "foreign");
  assert(await v.keyMatches(skey, serverDir));
  const inServer = (await v.listSecrets(skey, serverDir)).entries.map((e) => `${e.service}/${e.account}`);
  assert(!inServer.some((n) => n.startsWith("brain/") || n.startsWith("server-vault/")));
  assertEquals(
    await v.getSecret("claude", "work", "oauth-token", skey),
    null,
    "read from the owner's folder: not there",
  );
  // the server key is in the owner's vault, and the server vault holds no key material
  assert((await v.listSecrets(ownerKey)).entries.some((e) => e.service === "server-vault"));
  // a second run has nothing to do
  const again = await sv.syncServerVault();
  assertEquals([again.write.length, again.remove.length, again.created], [0, 0, false]);
  const stale = await sv.serverVaultStale();
  assertEquals([stale?.write.length, stale?.remove.length], [0, 0]);

  // a token changes, one is deleted, the selection shrinks: the server vault follows
  await v.setSecret("claude", "work", "sk-ant-oat01-bbbbbbbbbbbbbbbbbbbbbbbb", "oauth-token");
  await v.deleteSecret("passkey-revocations", "cred1");
  await Deno.writeTextFile(`${config}/nodes.json`, "{}");
  const next = await sv.syncServerVault();
  assertEquals(names(next.write), ["claude/work"]);
  assertEquals(names(next.remove), ["cloudflare/main", "passkey-revocations/cred1"]);
  const left = (await v.listSecrets(skey, serverDir)).entries.map((e) => `${e.service}/${e.account}`);
  assertEquals(left.sort(), ["approval/owner", "claude/work"]);

  // what a node does with it: its vault is the server folder, its key the server key
  const approval = (await approvalKeys(ownerKey.raw)).public;
  Deno.env.set("AGENTS_MULTI_VAULT", serverDir);
  await Deno.writeTextFile(`${tmp}/vault-key`, btoa(String.fromCharCode(...skey.raw)) + "\n");
  try {
    assertEquals(await approvalKey({} as never), approval, "the node pins the owner's public key, not one of its own");
    const { vaultKind } = v;
    assertEquals(await vaultKind(await v.loadKey()), "server");
  } finally {
    Deno.env.set("AGENTS_MULTI_VAULT", ownerDir);
    await Deno.writeTextFile(`${tmp}/vault-key`, btoa(String.fromCharCode(...ownerKey.raw)) + "\n");
  }
});

Deno.test("a server vault the owner's vault has no key for is refused, not overwritten", async () => {
  const key = await v.loadKey();
  const stray = `${tmp}/stray`;
  Deno.env.set("AGENTS_MULTI_SERVER_VAULT", stray);
  try {
    await Deno.mkdir(stray, { recursive: true });
    await Deno.writeTextFile(`${stray}/key-check.json`, "{}");
    // the owner's vault already has a server key (the test above): the stray folder is not that vault's
    await assertRejects(() => sv.ensureServerVault(), Error, "does not open");
    assert(key);
  } finally {
    Deno.env.set("AGENTS_MULTI_SERVER_VAULT", serverDir);
  }
});

Deno.test("doctor: the owner's side warns when the server vault is behind", () => {
  assertEquals(serverVaultFinding({ write: [], remove: [] })[1], "ok");
  const f = serverVaultFinding({ write: [entry("claude", "w")], remove: [] });
  assertEquals(f[1], "warn");
  assert(f[3]?.includes("agents vault server sync"));
});

const baseFacts = {
  cfg: { enabled: true, headless: true, repoRoots: ["~"], allowedDomains: [], repos: [] },
  keyMode: 0o600,
  exposed: [],
  service: "https://brain.example",
  approval: true,
  sandbox: null,
};

Deno.test("doctor: a headless node fails if its vault is the owner's or holds a brain entry", () => {
  const id = (f: unknown) =>
    nodeFindings({ ...baseFacts, vault: true, vaultScope: f } as never).find((c) => c.id === "node.vault.scope");
  assertEquals(id({ kind: "owner", brain: true })?.status, "fail");
  assertEquals(id({ kind: "server", brain: true })?.status, "fail");
  assertEquals(id({ kind: "server", brain: false })?.status, "ok");
  assertEquals(id(null), undefined);
});
