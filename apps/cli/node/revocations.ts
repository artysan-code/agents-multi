// revocations.ts — passkeys the owner revoked, kept in the vault (ADR 0014, second round). The vault is on every
// machine of the owner and the service has no way into it, so a node that opens it refuses a revoked passkey
// whatever the service still lists. One entry per passkey: service `passkey-revocations`, account the
// credential's id, value the date. Without a vault (a node pinned by `approvalKey` alone) there is nothing to
// read, and the service's withholding is all there is.

import { listSecrets, setSecret } from "../../../shared/mcp/lib/vault.ts";

export const REVOCATIONS = "passkey-revocations";

/** The credential ids revoked in this machine's vault; empty when there is no vault to open. */
export async function revokedIds(): Promise<ReadonlySet<string>> {
  try {
    return new Set((await listSecrets()).entries.filter((e) => e.service === REVOCATIONS).map((e) => e.account));
  } catch {
    return new Set();
  }
}

/** Writes the revocation of a passkey into the vault; throws when this machine has none. */
export async function revokeInVault(id: string, now = new Date()): Promise<void> {
  await setSecret(REVOCATIONS, id, now.toISOString());
}
