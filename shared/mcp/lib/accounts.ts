// accounts.ts — which accounts an MCP server may use, and which one a call means.
//
// accounts.json lists them, with no secret in it: service, a short name, the address, and the
// profiles that see it. It is the person's (their config folder, ~/.agents-multi/config); each
// account's secret is in the vault (vault.ts) under the same service/name.
//
// A server learns its profile from CLAUDE_MULTI_PROFILE, which `agents mcp sync` writes into
// each profile's configuration, and sees only that profile's accounts: the personal Google account
// does not exist for that profile. A profile can hold several accounts of one service; a tool call then
// names the one it means, and with a single one the name can be left out. Never a silent default
// among several.

import { configDir } from "./owner.ts";
import { amEnv } from "./env.ts";

export interface Account {
  service: string;
  name: string;
  url?: string;
  /** absent = every profile */
  profiles?: string[];
  /** the address the account signed in as (Google): shown, and used as the login hint */
  email?: string;
  /** "oauth": the server signs in by itself (a /mcp login per server): there is no secret in the vault */
  auth?: "oauth";
  note?: string;
}

function accountsFile(): string {
  return amEnv("ACCOUNTS") ?? `${configDir()}/accounts.json`;
}

export function loadAccounts(path = accountsFile()): Account[] {
  try {
    const d = JSON.parse(Deno.readTextFileSync(path)) as { accounts?: Account[] };
    return d.accounts ?? [];
  } catch {
    return [];
  }
}

/** Pure: the accounts of a service one profile sees. No profile (a server started by hand) sees
 *  only the accounts open to every profile. */
export function visibleAccounts(all: Account[], service: string, profile: string | undefined): Account[] {
  return all.filter((a) => a.service === service && (!a.profiles || (!!profile && a.profiles.includes(profile))));
}

/** Pure: the account a call means, or an error that says what to pass. */
export function resolveAccount(visible: Account[], requested: string | undefined, service: string): Account {
  const names = visible.map((a) => a.name);
  if (requested) {
    const hit = visible.find((a) => a.name === requested);
    if (hit) return hit;
    throw new Error(
      `no ${service} account "${requested}" for this profile${names.length ? ` (available: ${names.join(", ")})` : ""}`,
    );
  }
  if (visible.length === 1) return visible[0];
  if (!visible.length) throw new Error(`this profile has no ${service} account: add one in the console, Connections`);
  throw new Error(`this profile has several ${service} accounts: pass account = ${names.join(" | ")}`);
}

/** Pure: the hosts a server must reach, for its --allow-net. */
export function accountHosts(accounts: Account[]): string[] {
  const hosts = new Set<string>();
  for (const a of accounts) {
    if (!a.url) continue;
    try {
      hosts.add(new URL(a.url).host);
    } catch { /* an invalid address reaches nothing */ }
  }
  return [...hosts].sort();
}
