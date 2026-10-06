// accounts.ts — Connections: the accounts of accounts.json, whether this machine holds each one's
// secret, where each is in use, and adding, changing or removing one. Never a secret value out.

import { readJson, readText } from "../lib/fs.ts";
import { machine } from "../lib/machine.ts";
import { profileInfo, profileNames } from "../lib/profiles.ts";
import { ACCOUNTS, loadRegistry } from "../mcp/registry.ts";
import { type Mounted, placements, reach } from "../mcp/placement.ts";
import { missingPrograms } from "../mcp/health.ts";
import { type Account, loadAccounts } from "../../../shared/mcp/lib/accounts.ts";
import {
  deleteSecret,
  getSecret,
  keyMatches,
  listSecrets,
  loadKey,
  setSecret,
  vaultDir,
} from "../../../shared/mcp/lib/vault.ts";
import { probeAccount } from "../vault.ts";

/** What Connections shows: the accounts, whether this machine has each one's secret, and the vault's
 *  state. Never a secret value. */
export async function accountsView() {
  const reg = await loadRegistry();
  const services = [...new Set(Object.values(reg.servers).map((c) => c._service).filter((x): x is string => !!x))]
    .sort();
  const accounts = loadAccounts(ACCOUNTS);
  let state = "ok", detail = "", conflicts = 0, unreadable = 0;
  let have = new Set<string>();
  try {
    const key = await loadKey();
    if (!(await keyMatches(key))) state = "wrong-key";
    else {
      const l = await listSecrets(key);
      have = new Set(l.entries.map((e) => `${e.service}/${e.account}`));
      conflicts = l.conflicts;
      unreadable = l.unreadable;
    }
  } catch (e) {
    state = "no-key";
    detail = (e as Error).message;
  }
  const initialised = !!(await readText(`${vaultDir()}/key-check.json`));
  const googleClient = state === "ok" && !!(await getSecret("google-oauth", "client", "id").catch(() => null));
  const missing = new Map<string, Awaited<ReturnType<typeof missingPrograms>>>();
  for (const s of new Set(accounts.map((a) => a.service))) missing.set(s, await missingPrograms(s, reg));
  // where each account is in use, against what every profile mounted at its last sync
  const profiles = await profileNames();
  const mounted: Record<string, Mounted> = {};
  for (const p of profiles) {
    const i = await profileInfo(p);
    mounted[p] = { cli: i.mcp, desktop: i.desktopConfig ? i.mcpDesktop : null };
  }
  const where = reach(placements(reg), mounted, !!(await machine()).desktopVersion);
  const none = { profiles: [], pending: [], noDesktop: [] };
  return {
    google: { client: googleClient, last: lastConnect },
    vault: { dir: vaultDir(), state, detail, initialised, conflicts, unreadable },
    services,
    profiles,
    accounts: accounts.map((a) => ({
      ...a,
      hasSecret: have.has(`${a.service}/${a.name}`),
      missing: missing.get(a.service) ?? [],
      reach: where[`${a.service}/${a.name}`] ?? none,
    })),
    // the servers that need no account (the registry's own entries, turned on by profile)
    servers: Object.entries(where).filter(([k]) => k.startsWith("server/")).map(([k, r]) => ({
      name: k.slice(7),
      ...r,
    })),
  };
}

const ACCOUNT_NAME = /^[a-z][a-z0-9_-]{0,30}$/;
/** How the last Google connection or brain sign-in ended: the page shows it when the browser comes back. */
let lastConnect: { account: string; ok: boolean; message: string; at: string } | null = null;

/** Records how a Google connection or a brain sign-in ended, for the page to show. */
export function recordConnect(account: string, r: { ok: boolean; message: string }) {
  lastConnect = { account, ...r, at: new Date().toISOString() };
}

/** Add or change an account (and its secret), or remove one. The secret, when given, is checked
 *  against the service first: a wrong one is refused rather than stored. */
export async function accountOp(
  b: { op?: string; service?: string; name?: string; url?: string; profiles?: string[] | null; secret?: string },
) {
  const service = String(b.service ?? ""), name = String(b.name ?? "").trim();
  if (!service || !ACCOUNT_NAME.test(name)) {
    return { ok: false, message: "the name is lowercase letters, digits, - or _, starting with a letter" };
  }
  const raw = await readJson<{ accounts: Account[] } & Record<string, unknown>>(ACCOUNTS) ?? { accounts: [] };
  const i = raw.accounts.findIndex((a) => a.service === service && a.name === name);
  if (b.op === "delete") {
    if (i >= 0) raw.accounts.splice(i, 1);
    await Deno.writeTextFile(ACCOUNTS, JSON.stringify(raw, null, 2) + "\n");
    const gone = await deleteSecret(service, name).catch(() => false);
    return { ok: true, message: `${service}/${name} removed${gone ? " with its secret" : ""}` };
  }
  let url: string | undefined;
  if (b.url?.trim()) {
    try {
      url = new URL(b.url.trim()).origin;
    } catch {
      return { ok: false, message: "the address is not a valid URL" };
    }
  }
  const account: Account = {
    service,
    name,
    ...(url ? { url } : {}),
    ...(b.profiles?.length ? { profiles: [...b.profiles].sort() } : {}),
  };
  if (b.secret) {
    const probe = await probeAccount(account, b.secret);
    if (!probe.ok) {
      return { ok: false, message: `the secret does not open ${service}/${name} (${probe.detail}): not stored` };
    }
    await setSecret(service, name, b.secret);
  }
  if (i >= 0) {
    raw.accounts[i] = { ...raw.accounts[i], ...account, ...(b.profiles?.length ? {} : { profiles: undefined }) };
  } else raw.accounts.push(account);
  raw.accounts = raw.accounts.map((a) => JSON.parse(JSON.stringify(a))); // drop undefined keys
  await Deno.writeTextFile(ACCOUNTS, JSON.stringify(raw, null, 2) + "\n");
  // saved either way (the program can be installed afterwards), but said now: its server will not start until then
  const missing = await missingPrograms(service);
  const warn = missing.map((m) =>
    `the ${m.server} server will not start: ${m.problem}${m.install ? ` — install it with: ${m.install}` : ""}`
  ).join("; ");
  return {
    ok: true,
    message: `${service}/${name} saved${b.secret ? ", secret checked and stored" : ""}${warn ? `. But ${warn}` : ""}`,
    ...(missing.length ? { missing } : {}),
  };
}
