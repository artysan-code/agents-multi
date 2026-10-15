// passkeys.ts — `agents passkeys`: the passkeys the phone registered, and the owner's endorsement of them (ADR
// 0014, G5). A passkey counts only once a machine with the vault signed `agents-multi passkey v1 / <id> / <key>`
// with the approval key; the service keeps that signature and cannot make one, and the nodes check it. The
// owner sees the name and the fingerprint here and compares the fingerprint with the phone's before saying yes.

import { type ApprovalKeys, approvalKeys } from "../../shared/mcp/lib/nodes.ts";
import { fingerprint, type Passkey, signEndorsement, verifyEndorsement } from "../../shared/mcp/lib/webauthn.ts";
import { loadKey } from "../../shared/mcp/lib/vault.ts";
import { type Service, service } from "./node/service.ts";
import { getPasskeys } from "./node/waiting.ts";
import { revokedIds, revokeInVault } from "./node/revocations.ts";
import { ago } from "./nodes.ts";

export type PasskeyState = "pending" | "endorsed" | "not valid here" | "endorsed (unchecked)" | "revoked";

export interface PasskeyRow {
  id: string;
  name: string;
  fingerprint: string;
  state: PasskeyState;
  created: string;
}

/** Pure but for WebCrypto: where a passkey stands as this machine sees it. `ownerKey`: the public approval key
 *  here, null when this machine has no vault (it cannot tell a good endorsement from a forged one). */
export async function stateOf(
  p: Passkey,
  ownerKey: string | null,
  revoked: ReadonlySet<string> = new Set(),
): Promise<PasskeyState> {
  if (revoked.has(p.id)) return "revoked";
  if (!p.endorsement) return "pending";
  if (!ownerKey) return "endorsed (unchecked)";
  return (await verifyEndorsement(p, ownerKey)) ? "endorsed" : "not valid here";
}

export async function rowsOf(
  list: Passkey[],
  ownerKey: string | null,
  revoked: ReadonlySet<string> = new Set(),
): Promise<PasskeyRow[]> {
  return await Promise.all(list.map(async (p) => ({
    id: p.id,
    name: p.name,
    fingerprint: await fingerprint(p.publicKey),
    state: await stateOf(p, ownerKey, revoked),
    created: p.created,
  })));
}

/** Pure: the lines `agents passkeys` prints. */
export function passkeyLines(rows: PasskeyRow[], now: number): string[] {
  if (!rows.length) return ["no passkey: register one in the web app (Settings), then endorse it here"];
  const cells = rows.map((r) => [r.id.slice(0, 12), r.name, r.fingerprint, r.state, `${ago(r.created, now)} ago`]);
  const width = cells[0].map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  return cells.map((c) => c.map((x, i) => (i < c.length - 1 ? x.padEnd(width[i]) : x)).join("  ").trimEnd());
}

/** Pure: the passkey a reference names — its id, or the start of it when that is unambiguous. */
export function findPasskey(list: Passkey[], ref: string): Passkey | string {
  if (!ref) return "name a passkey (agents passkeys lists them)";
  const hit = list.filter((p) => p.id === ref);
  const some = hit.length ? hit : list.filter((p) => p.id.startsWith(ref));
  if (some.length === 1) return some[0];
  return some.length ? `${ref} names ${some.length} passkeys: give more of the id` : `no passkey ${ref}`;
}

/** The owner's approval keys from this machine's vault. */
export const ownerKeys = async (): Promise<ApprovalKeys> => await approvalKeys((await loadKey()).raw);

/** The public approval key of this machine's vault, or null without one. */
export async function ownerKeyOrNull(): Promise<string | null> {
  try {
    return (await ownerKeys()).public;
  } catch {
    return null;
  }
}

/** Signs a passkey with the approval key and sends the endorsement. The caller has shown the owner what they
 *  endorse and had their yes. */
export async function endorse(s: Service, p: Passkey, keys: ApprovalKeys): Promise<void> {
  const signature = await signEndorsement(p.id, p.publicKey, keys.sign);
  await s.call("POST", `/api/passkeys/${p.id}/endorse`, { signature });
}

/** What the console's Connections page shows: the passkeys with their state, whether this machine can endorse
 *  (it has a vault), and why there is nothing to show when the service cannot be reached. */
export async function passkeysView(): Promise<
  { available: boolean; message?: string; canEndorse: boolean; passkeys: PasskeyRow[] }
> {
  const s = await service().catch((e: Error) => e.message);
  if (typeof s === "string") return { available: false, message: s, canEndorse: false, passkeys: [] };
  const key = await ownerKeyOrNull();
  try {
    return {
      available: true,
      canEndorse: !!key,
      passkeys: await rowsOf(await getPasskeys(s), key, await revokedIds()),
    };
  } catch (e) {
    return { available: false, message: (e as Error).message, canEndorse: !!key, passkeys: [] };
  }
}

/** The console's endorsement: the page has shown the name and the fingerprint and asked for a confirmation, and
 *  sends back the fingerprint the owner said yes to. The passkey is read again from the service here, so it is
 *  signed only if its key is still the one shown: a key swapped under the same id between the page and this
 *  call (a stolen web session re-registering it) is refused, never signed. */
export async function endorseOp(id: string, seen: string): Promise<{ ok: boolean; message: string }> {
  try {
    const s = await service();
    if (typeof s === "string") return { ok: false, message: s };
    const p = findPasskey(await getPasskeys(s), id);
    if (typeof p === "string") return { ok: false, message: p };
    if (!seen || (await fingerprint(p.publicKey)) !== seen) {
      return { ok: false, message: "this passkey changed since it was shown: nothing signed; look at it again" };
    }
    await endorse(s, p, await ownerKeys());
    return { ok: true, message: p.name };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Pure: the credential a revoke names — one the service lists (its id, or the start of it), else a whole id
 *  as it was printed, for a passkey the service no longer lists but a vault should still refuse. */
export function revokeTarget(list: Passkey[], ref: string): { id: string; name: string; listed: boolean } | string {
  const p = findPasskey(list, ref);
  if (typeof p !== "string") return { id: p.id, name: p.name, listed: true };
  return /^[\w-]{40,}$/.test(ref) && !list.some((x) => x.id.startsWith(ref))
    ? { id: ref, name: ref.slice(0, 12), listed: false }
    : p;
}

/** Revokes a passkey: the revocation goes into the vault first (every machine of the owner has it, and a node
 *  refuses a revoked passkey whatever the service lists), then the service is told to hide it. The caller has
 *  had the owner's yes. */
export async function revoke(s: Service, t: { id: string; listed: boolean }): Promise<void> {
  await revokeInVault(t.id);
  if (t.listed) await s.call("DELETE", `/api/passkeys/${encodeURIComponent(t.id)}`);
}

/** The console's revoke: the page asked the owner first. */
export async function revokeOp(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    const s = await service();
    if (typeof s === "string") return { ok: false, message: s };
    const t = revokeTarget(await getPasskeys(s), id);
    if (typeof t === "string") return { ok: false, message: t };
    await revoke(s, t);
    return { ok: true, message: t.name };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

const USAGE = `agents passkeys                  the phone's passkeys: name, fingerprint, and whether you endorsed them
agents passkeys endorse <id>     show one, ask yes, sign it here with the approval key and send the endorsement
agents passkeys revoke <id>      ask yes, write the revocation into the vault (every node with it refuses the
                                 passkey from then on) and have the service drop it`;

export async function passkeysCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "--help" || sub === "-h" || (sub && sub !== "list" && sub !== "endorse" && sub !== "revoke")) {
    console.log(USAGE);
    return sub === "--help" || sub === "-h" ? 0 : 2;
  }
  const s = await service().catch((e: Error) => e.message);
  if (typeof s === "string") {
    console.error(`agents passkeys: ${s}`);
    return 1;
  }
  try {
    const list = await getPasskeys(s);
    if (sub === "revoke") {
      const t = revokeTarget(list, rest.find((a) => !a.startsWith("--")) ?? "");
      if (typeof t === "string") {
        console.error(`agents passkeys: ${t}`);
        return 1;
      }
      console.log(`passkey ${t.name}\n  id  ${t.id}${t.listed ? "" : "\n  (the service does not list it any more)"}`);
      console.log("Nothing signed with it will count any more, on any machine that has your vault.");
      const yes = prompt("Revoke it? Type yes to continue:");
      if (yes?.trim().toLowerCase() !== "yes") {
        console.log("not revoked");
        return 1;
      }
      await revoke(s, t);
      console.log(`${t.name}: revoked, in the vault and on the service`);
      return 0;
    }
    if (sub !== "endorse") {
      console.log(
        passkeyLines(await rowsOf(list, await ownerKeyOrNull(), await revokedIds()), Date.now()).join("\n"),
      );
      return 0;
    }
    const p = findPasskey(list, rest.find((a) => !a.startsWith("--")) ?? "");
    if (typeof p === "string") {
      console.error(`agents passkeys: ${p}`);
      return 1;
    }
    const keys = await ownerKeys().catch(() => null);
    if (!keys) {
      console.error("agents passkeys: this machine has no vault, so it cannot sign an endorsement: use one that has");
      return 1;
    }
    console.log(
      `passkey ${p.name}\n  id           ${p.id}\n  fingerprint  ${await fingerprint(
        p.publicKey,
      )}\n  registered   ${p.created}`,
    );
    if (p.endorsement) console.log("  (already endorsed; this signs it again)");
    console.log("It will be able to say yes for you, from the phone, to what your machines ask.");
    const yes = prompt("Is this your phone's passkey, with the same fingerprint? Type yes to endorse it:");
    if (yes?.trim().toLowerCase() !== "yes") {
      console.log("not endorsed");
      return 1;
    }
    await endorse(s, p, keys);
    console.log(`${p.name}: endorsed, signed here`);
    return 0;
  } catch (e) {
    const m = (e as Error).message;
    // a service from before ADR 0014's G5 has no passkeys
    const old = /\/api\/passkeys\S*: (not found|HTTP 404)$/.test(m);
    console.error(
      `agents passkeys: ${m}${old ? " — the service runs a version without passkeys: update the brain" : ""}`,
    );
    return 1;
  }
}
