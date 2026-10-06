// service.ts — the part every account-backed MCP server shares: the accounts this profile sees, the
// `account` argument of each tool, and the secret of the account a call means, read from the vault
// when first needed and kept in memory for the life of the process only.

import { z } from "npm:zod@^3.23";
import { type Account, loadAccounts, resolveAccount, visibleAccounts } from "./accounts.ts";
import { getSecret } from "./vault.ts";

export function service(name: string) {
  const profile = Deno.env.get("CLAUDE_MULTI_PROFILE") || undefined;
  const visible = visibleAccounts(loadAccounts(), name, profile);
  const secrets = new Map<string, string>();

  /** The `account` argument: optional when this profile has one account, required otherwise. */
  const accountArg = visible.length > 1
    ? z.enum(visible.map((a) => a.name) as [string, ...string[]]).describe(
      `which ${name} account: ${visible.map((a) => a.name).join(", ")}`,
    )
    : z.string().optional().describe(
      visible.length
        ? `${name} account (only one: ${visible[0].name})`
        : `${name} account (none configured for this profile)`,
    );

  async function use(requested?: string): Promise<{ account: Account; secret: string }> {
    const account = resolveAccount(visible, requested, name);
    let secret = secrets.get(account.name);
    if (!secret) {
      const s = await getSecret(name, account.name);
      if (!s) {
        throw new Error(`no secret for ${name}/${account.name} on this machine: add it in the console, Connections`);
      }
      secret = s;
      secrets.set(account.name, s);
    }
    return { account, secret };
  }

  return { profile, visible, accountArg, use };
}

export const text = (o: unknown) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});
