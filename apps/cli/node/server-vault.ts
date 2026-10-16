// server-vault.ts — the vault a server node gets instead of the owner's (ADR 0015). Syncthing cannot leave files
// out of a folder for one device, so the server has a folder of its own, `~/agents-multi-vault-server`, sealed with a
// key of its own that lives in the owner's vault and nowhere on a server's side but the one pairing seals to it. This
// module, on the owner's machine, keeps that folder equal to a selection of the owner's vault: Claude's tokens, what a
// node reads from its vault by design, and the `<service>/<account>` pairs `nodes.json` lists in `serverServices`.
// Never the brain's, never the vault's own key. It prints names, never values.

import { APPROVAL_ENTRY as APPROVAL, approvalKeys } from "../../../shared/mcp/lib/nodes.ts";
import { loadNodeConfig } from "../../../shared/mcp/lib/headless.ts";
import {
  type Entry,
  getSecret,
  hasVault,
  importKey,
  initVaultAt,
  keyMatches,
  loadKey,
  newKeyBytes,
  putEntry,
  readEntries,
  recoveryCode,
  serverVaultDir,
  setSecret,
  VaultError,
  type VaultKey,
} from "../../../shared/mcp/lib/vault.ts";
import { REVOCATIONS } from "./revocations.ts";
import { SEED } from "./seed.ts";

/** Where the server vault's key is kept: an entry of the owner's vault, which reaches the owner's machines and the
 *  vault's recovery code, and no server. */
export const SERVER_KEY = { service: "server-vault", account: "key", field: "token" } as const;
/** The services a node reads from its vault by design, whatever `serverServices` says. */
export const ALWAYS_SERVICES: readonly string[] = ["claude", REVOCATIONS, SEED.service, APPROVAL.service];
/** Services that never go to a server, even when listed. */
const NEVER_SERVICES: readonly string[] = ["brain", SERVER_KEY.service];

type Id = Pick<Entry, "service" | "account">;
const name = (e: Pick<Entry, "service" | "account" | "field">) =>
  `${e.service}/${e.account}${e.field === "token" ? "" : ` (${e.field})`}`;
const same = (a: Entry, b: Entry) => a.service === b.service && a.account === b.account && a.field === b.field;

/** Pure: whether a server's vault takes this entry of the owner's. */
export function selected(e: Id, extra: readonly string[] = []): boolean {
  if (NEVER_SERVICES.includes(e.service.toLowerCase())) return false;
  return ALWAYS_SERVICES.includes(e.service) || extra.includes(`${e.service}/${e.account}`);
}

export interface SyncPlan {
  write: Entry[];
  remove: Entry[];
}

/** Pure: what to write into the server vault and what to take out, given the owner's entries and the server's.
 *  Deleted entries (tombstones) are nothing on either side. */
export function planSync(owner: Entry[], server: Entry[], extra: readonly string[] = []): SyncPlan {
  const want = owner.filter((e) => !e.deleted && e.value && selected(e, extra));
  const have = server.filter((e) => !e.deleted);
  return {
    write: want.filter((e) => !have.some((h) => same(h, e) && h.value === e.value)),
    remove: have.filter((h) => !want.some((e) => same(h, e))),
  };
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The server vault's key from the owner's vault, or null when there is none yet. */
export async function serverKey(): Promise<VaultKey | null> {
  const k = await getSecret(SERVER_KEY.service, SERVER_KEY.account, SERVER_KEY.field);
  return k ? await importKey(unb64(k)) : null;
}

/** The key, made (and the server vault folder started) when there is none: `created` says so. */
export async function ensureServerVault(): Promise<{ key: VaultKey; created: boolean }> {
  const dir = serverVaultDir();
  let key = await serverKey();
  let created = false;
  if (!key) {
    if (hasVault(dir)) {
      throw new VaultError(`${dir} holds a vault but the owner's vault has no key for it: remove the folder or pair`);
    }
    const raw = newKeyBytes();
    await setSecret(SERVER_KEY.service, SERVER_KEY.account, b64(raw), SERVER_KEY.field);
    key = await importKey(raw);
    created = true;
  }
  if (!hasVault(dir)) {
    await initVaultAt(dir, key);
    created = true;
  } else if (!(await keyMatches(key, dir))) {
    throw new VaultError(`the server key does not open ${dir}`);
  }
  return { key, created };
}

/** The owner's vault entries a server may get, plus the approval key: read with the owner's key. */
async function ownerEntries(ownerKey: VaultKey): Promise<Entry[]> {
  const { entries } = await readEntries(ownerKey);
  const pub = (await approvalKeys(ownerKey.raw)).public;
  return [...entries, { ...APPROVAL, value: pub, updatedAt: new Date().toISOString() }];
}

export interface SyncResult extends SyncPlan {
  created: boolean;
}

/** Makes the server vault what the selection says: the entries re-sealed under the server key, the others deleted as
 *  tombstones. `dryRun` only computes the plan. */
export async function syncServerVault(dryRun = false): Promise<SyncResult> {
  const extra = (await loadNodeConfig()).serverServices ?? [];
  const ownerKey = await loadKey();
  const { key, created } = dryRun ? { key: await serverKey(), created: false } : await ensureServerVault();
  const dir = serverVaultDir();
  const server = key && hasVault(dir) ? (await readEntries(key, dir)).entries : [];
  const plan = planSync(await ownerEntries(ownerKey), server, extra);
  if (!dryRun && key) {
    const at = new Date().toISOString();
    for (const e of plan.write) await putEntry(dir, key, { ...e, updatedAt: at });
    for (const e of plan.remove) await putEntry(dir, key, { ...e, value: "", deleted: true, updatedAt: at });
  }
  return { ...plan, created };
}

/** For the doctor: what the server vault is behind by, or null when there is no server vault (or no key for it). */
export async function serverVaultStale(): Promise<SyncPlan | null> {
  if (!hasVault(serverVaultDir())) return null;
  const key = await serverKey().catch(() => null);
  if (!key) return null;
  return await syncServerVault(true);
}

/** After a write that a server reads (a Claude token, a revocation, a seed): sync when the server vault exists, and
 *  say it in a line; null when there is none. Never throws — the doctor says when it is behind. */
export async function syncIfPresent(): Promise<string | null> {
  if (!hasVault(serverVaultDir())) return null;
  try {
    const r = await syncServerVault();
    return summary(r);
  } catch (e) {
    return `server vault: not updated (${(e as Error).message}); agents vault server sync`;
  }
}

/** Pure: a sync as a line of names. */
export function summary(r: SyncPlan): string {
  const parts = [...r.write.map((e) => `+${name(e)}`), ...r.remove.map((e) => `-${name(e)}`)];
  return parts.length ? `server vault: ${parts.join(" ")}` : "server vault: already up to date";
}

/** The server key as a recovery code, for a server paired by terminal. */
export async function serverRecoveryCode(): Promise<string> {
  const k = await serverKey();
  if (!k) throw new VaultError("no server vault yet: agents vault server sync");
  return recoveryCode(k.raw);
}

/** The key a pairing seals to a server (raw 32 bytes): the server vault's, made if need be and brought up to date. */
export async function serverKeyForPairing(): Promise<Uint8Array> {
  const { key } = await ensureServerVault();
  await syncServerVault().catch(() => {}); // the doctor says when it is behind
  return key.raw;
}
