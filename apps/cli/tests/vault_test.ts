// Tests for shared/mcp/lib/vault.ts: the crypto and the store, on a throwaway directory and a key
// passed in directly (the keyring is not touched).
import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";

const dir = await Deno.makeTempDir();
Deno.env.set("CLAUDE_MULTI_VAULT", dir);
const v = await import("../../../shared/mcp/lib/vault.ts");

Deno.test("recovery code: round trip, forgiving about case, dashes and look-alikes", () => {
  const raw = v.newKeyBytes();
  const code = v.recoveryCode(raw);
  assertEquals(code.replace(/-/g, "").length, 52);
  assertEquals(v.parseRecoveryCode(code), raw);
  assertEquals(v.parseRecoveryCode(code.toLowerCase().replace(/-/g, " ")), raw);
  assertThrows(() => v.parseRecoveryCode(code.slice(0, 20)), Error, "exactly 32 bytes");
});

Deno.test("seal/open: round trip, and an entry moved to another id does not open", async () => {
  const k = await v.importKey(v.newKeyBytes());
  const box = await v.seal(k, "id-a", "s3cret");
  assertEquals(await v.open(k, "id-a", box), "s3cret");
  await assertRejects(() => v.open(k, "id-b", box));
  const other = await v.importKey(v.newKeyBytes());
  await assertRejects(() => v.open(other, "id-a", box));
  // two writes of the same value never produce the same bytes
  assertNotEquals((await v.seal(k, "id-a", "s3cret")).ct, box.ct);
});

Deno.test("store: set, get, list without values, delete as a tombstone", async () => {
  const k = await v.importKey(v.newKeyBytes());
  await v.setSecret("n8n", "ark", "key-1", "token", k);
  await v.setSecret("coolify", "ark", "key-2", "token", k);
  assertEquals(await v.getSecret("n8n", "ark", "token", k), "key-1");
  const files = [...Deno.readDirSync(`${dir}/secrets`)].map((f) => f.name);
  // file names say nothing about what is inside
  assert(files.every((f) => /^[0-9a-f]{32}\.json$/.test(f)));
  assert(!files.some((f) => f.includes("n8n")));
  const listed = await v.listSecrets(k);
  assertEquals(listed.entries.map((e) => `${e.service}/${e.account}`), ["coolify/ark", "n8n/ark"]);
  assert(!JSON.stringify(listed).includes("key-1"));
  assertEquals(await v.deleteSecret("n8n", "ark", "token", k), true);
  assertEquals(await v.getSecret("n8n", "ark", "token", k), null);
  // the file stays, rewritten: a deletion travels through Syncthing as a modification
  assertEquals([...Deno.readDirSync(`${dir}/secrets`)].length, 2);
  assertEquals((await v.listSecrets(k)).entries.length, 1);
  // a Syncthing conflict copy is counted, not read
  await Deno.writeTextFile(`${dir}/secrets/${files[0].slice(0, -5)}.sync-conflict-20260930-120000-ABCDEFG.json`, "{}");
  assertEquals((await v.listSecrets(k)).conflicts, 1);
});

Deno.test("probeRequest: on the account's address, on the service's API, or no check", async () => {
  const { probeRequest } = await import("../vault.ts");
  assertEquals(probeRequest({ service: "n8n", url: "https://n8n.example/" }, "k"), {
    url: "https://n8n.example/api/v1/workflows?limit=1",
    header: "X-N8N-API-KEY: k",
  });
  assertEquals(probeRequest({ service: "gitea", url: "https://git.example" }, "k")?.header, "Authorization: token k");
  // a Supabase token is not tied to an address: it is tried on Supabase's own API
  assertEquals(probeRequest({ service: "supabase" }, "k")?.url, "https://api.supabase.com/v1/projects");
  // no address to try it on, or no check for the service
  assertEquals(probeRequest({ service: "coolify" }, "k"), null);
  assertEquals(probeRequest({ service: "railway", url: "https://x" }, "k"), null);
});
