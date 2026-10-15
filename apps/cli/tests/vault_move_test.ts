// vault_move_test.ts — the vault's own folder (1.2.1, ADR 0012 amendment): which folder is read while machines
// move, the move itself, and the address a sign-in with no browser takes back.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { LEGACY_VAULT_DIR, moveVault, pickVaultDir, VAULT_DIR, VaultError } from "../../../shared/mcp/lib/vault.ts";
import { pastedCallback } from "../brain-login.ts";

Deno.test("vault: the new folder once it has a vault (or for a new one), the old one until then", () => {
  assertEquals(pickVaultDir(true, true), VAULT_DIR);
  assertEquals(pickVaultDir(true, false), VAULT_DIR);
  assertEquals(pickVaultDir(false, true), LEGACY_VAULT_DIR);
  assertEquals(pickVaultDir(false, false), VAULT_DIR);
  assert(VAULT_DIR.endsWith("/agents-multi-vault") && LEGACY_VAULT_DIR.endsWith("/vault/claude-multi"));
});

Deno.test("vault move: entries and key check copied, conflict copies left, the old folder kept", async () => {
  const root = await Deno.makeTempDir({ prefix: "am-vmove-" });
  try {
    const from = `${root}/old`, to = `${root}/new`;
    await Deno.mkdir(`${from}/secrets`, { recursive: true });
    await Deno.writeTextFile(`${from}/key-check.json`, "{}");
    await Deno.writeTextFile(`${from}/secrets/a.json`, "{}");
    await Deno.writeTextFile(`${from}/secrets/a.sync-conflict-20261015.json`, "{}");
    assertEquals(await moveVault(from, to), 2);
    assert(await Deno.stat(`${to}/secrets/a.json`));
    await assertRejects(() => Deno.stat(`${to}/secrets/a.sync-conflict-20261015.json`));
    assert(await Deno.stat(`${from}/secrets/a.json`), "the old folder stays");
    await assertRejects(() => moveVault(from, to), VaultError, "already holds");
    await assertRejects(() => moveVault(`${root}/none`, `${root}/other`), VaultError, "no vault");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("sign-in with no browser: only this sign-in's callback with its answer is taken back", () => {
  const r = "http://127.0.0.1:40123/callback";
  const ok = `${r}?code=abc&state=xyz`;
  assertEquals(pastedCallback(`  ${ok}  `, r), ok);
  assertEquals(pastedCallback(`${r}?error=access_denied&state=xyz`, r), `${r}?error=access_denied&state=xyz`);
  assertEquals(pastedCallback(`${r}?code=abc`, r), null, "no state");
  assertEquals(pastedCallback("http://127.0.0.1:9999/callback?code=a&state=b", r), null, "another sign-in");
  assertEquals(pastedCallback("https://evil.example/callback?code=a&state=b", r), null);
  assertEquals(pastedCallback("", r), null);
});
