// vault.ts — The secret vault, the accounts that need it, and the deny rules and hooks that protect its key.

import { loadAccounts } from "../../../../shared/mcp/lib/accounts.ts";
import { getSecret, keyMatches, listSecrets, loadKey, vaultDir } from "../../../../shared/mcp/lib/vault.ts";
import { lstat, readJson, readText } from "../../lib/fs.ts";
import { HOME, REPO, shortHome } from "../../lib/paths.ts";
import { ACCOUNTS } from "../../mcp/registry.ts";
import { probeAccount } from "../../vault.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/**
 * Pure: whether a probe's detail says the service refused the credential (HTTP 401 or 403), as
 * opposed to not answering at all.
 *
 * @param detail the `detail` of a `probeAccount` result
 */
export const keyRefused = (detail: string): boolean => /HTTP 40[13]/.test(detail);

/** The secret vault, the accounts that need it, and the deny rules and hooks that protect its key. */
export async function vaultChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- the secret vault and the accounts that need it
  const accounts = loadAccounts(ACCOUNTS);
  if (accounts.length) {
    const key = await loadKey().catch((e) => e as Error);
    const initialised = !!(await readText(`${vaultDir()}/key-check.json`));
    if (key instanceof Error) {
      add(
        "vault",
        "fail",
        initialised
          ? "this machine is not paired with the secret vault: account-backed MCP servers cannot work"
          : "no secret vault yet: account-backed MCP servers cannot work",
        initialised
          ? "claude-multi vault pair (in a terminal, with the recovery code)"
          : "claude-multi vault init (in a terminal)",
      );
    } else if (!(await keyMatches(key))) {
      add(
        "vault",
        "fail",
        "this machine's vault key does not open the vault",
        "claude-multi vault pair (with the right recovery code)",
      );
    } else {
      const l = await listSecrets(key);
      // an OAuth account signs in by itself, per server (/mcp): there is nothing of it in the vault
      const missing = accounts.filter((a) =>
        a.auth !== "oauth" && !l.entries.some((e) => e.service === a.service && e.account === a.name)
      );
      if (missing.length) {
        add(
          "vault.secrets",
          "warn",
          `no secret for ${missing.map((a) => `${a.service}/${a.name}`).join(", ")}`,
          "console › Connections, or claude-multi vault set <service> <account>",
        );
      }
      if (l.conflicts) {
        add(
          "vault.conflicts",
          "warn",
          `${l.conflicts} Syncthing conflict copies in the vault`,
          `ls ${vaultDir()}/secrets/*sync-conflict*`,
        );
      }
      if (l.unreadable) {
        add(
          "vault.unreadable",
          "fail",
          `${l.unreadable} vault entries this key cannot open`,
          "claude-multi vault status",
        );
      }
      if (!missing.length && !l.conflicts && !l.unreadable) {
        add("vault", "ok", `secret vault: ${accounts.length} accounts, every secret here`);
      }
      // a secret can be here and dead (expired, revoked): one request each says whether the service
      // still takes it. The brain has its own check below; a service with no probe is not counted.
      const held = accounts.filter((a) =>
        a.service !== "brain" && a.auth !== "oauth" &&
        l.entries.some((e) => e.service === a.service && e.account === a.name)
      );
      const tried = await Promise.all(held.map(async (a) => {
        const secret = await getSecret(a.service, a.name).catch(() => null);
        return { a, r: secret ? await probeAccount(a, secret) : { ok: false, detail: "unreadable", checked: true } };
      }));
      const checked = tried.filter((x) => x.r.checked !== false);
      const refused = checked.filter((x) => keyRefused(x.r.detail));
      const silent = checked.filter((x) => !x.r.ok && !refused.includes(x));
      const name = (x: { a: { service: string; name: string }; r: { detail: string } }) =>
        `${x.a.service}/${x.a.name} (${x.r.detail})`;
      if (refused.length) {
        add(
          "vault.keys",
          "fail",
          `the service refuses the key of ${refused.map(name).join(", ")}: expired or revoked`,
          "a new key: console › Connections › the account › Edit",
        );
      }
      if (silent.length) {
        add(
          "vault.reach",
          "warn",
          `no answer to check the key of ${silent.map(name).join(", ")}`,
          "claude-multi doctor (later)",
        );
      }
      if (checked.length && !refused.length && !silent.length) {
        add("vault.keys", "ok", `account keys: ${checked.length} tried, every one accepted`);
      }
      if (
        accounts.some((a) => a.service === "google") &&
        !l.entries.some((e) => e.service === "google-oauth" && e.account === "client")
      ) {
        add(
          "google.client",
          "warn",
          "Google accounts are listed but the OAuth client is not in the vault: none of them can connect",
          "console › Connections › Import the JSON, or claude-multi google client <file.json>",
        );
      }
    }
    // The key sits in the keyring, readable by any process of this user — Claude's Bash included.
    // These deny rules are what keeps a session from reading it, or the entries it opens.
    const deny =
      (await readJson<{ permissions?: { deny?: string[] } }>(`${REPO}/shared/settings.json`))?.permissions?.deny ?? [];
    const needed = [
      "Bash(secret-tool:*)",
      "Bash(kwallet-query:*)",
      "Bash(claude-multi vault recovery-code:*)",
      "Read(~/vault/claude-multi/**)",
      "Edit(~/vault/claude-multi/**)",
    ];
    const absent = needed.filter((r) => !deny.includes(r));
    if (absent.length) {
      add(
        "vault.deny",
        "fail",
        `Claude sessions could read the vault key or entries: shared deny lacks ${absent.join(", ")}`,
        "console › System › Permissions › Denied",
      );
    }
    // launch.ts hands a secret out (headers prints it): vault-guard.sh keeps sessions from running it
    const settings = await readJson<
      { hooks?: { PreToolUse?: { matcher?: string; hooks?: { command?: string }[] }[] } }
    >(`${REPO}/shared/settings.json`);
    const guarded = (settings?.hooks?.PreToolUse ?? []).some((h) =>
      h.matcher === "Bash" && h.hooks?.some((x) => x.command?.includes("hooks/vault-guard.sh"))
    );
    if (!guarded) {
      add(
        "vault.guard",
        "fail",
        "Claude sessions could run launch.ts and print a vault secret: shared/settings.json has no Bash hook vault-guard.sh",
        "add shared/hooks/vault-guard.sh to PreToolUse › Bash in shared/settings.json",
      );
    }
    // wrangler's own login keeps a broad OAuth token outside the vault, where vault run's checks do not reach
    const wranglerLogin = [`${HOME}/.config/.wrangler/config/default.toml`, `${HOME}/.wrangler/config/default.toml`];
    for (const f of wranglerLogin) {
      if (await lstat(f)) {
        add(
          "vault.wrangler",
          "warn",
          `wrangler is logged in outside the vault (${shortHome(f)})`,
          "wrangler logout, then claude-multi vault run cloudflare -- wrangler …",
        );
      }
    }
  }
  return c;
}
