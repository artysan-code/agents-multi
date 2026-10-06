// doctor — every invariant of the setup as a check with a verdict and a fix.
// The README describes, the doctor verifies. New invariants belong in a group under checks/, not in prose.

import { type Check } from "../lib/output.ts";
import { appChecks } from "./checks/app.ts";
import { binariesChecks } from "./checks/binaries.ts";
import { brainChecks } from "./checks/brain.ts";
import { configChecks } from "./checks/config.ts";
import { consoleChecks } from "./checks/console.ts";
import { desktopChecks, desktopPackagingChecks } from "./checks/desktop.ts";
import { agentsChecks } from "./checks/agents.ts";
import { gitIgnoreChecks } from "./checks/gitignore.ts";
import { loginChecks } from "./checks/logins.ts";
import { mcpChecks, mcpLegacyChecks } from "./checks/mcp.ts";
import { profileChecks } from "./checks/profiles.ts";
import { repoChecks } from "./checks/repo.ts";
import { runtimeChecks } from "./checks/runtime.ts";
import { sharedChecks } from "./checks/shared.ts";
import { stubChecks } from "./checks/stub.ts";
import { syncthingChecks } from "./checks/syncthing.ts";
import { updateChecks } from "./checks/updates.ts";
import { updateLockChecks } from "./checks/updatelock.ts";
import { vaultChecks } from "./checks/vault.ts";
import { zshrcChecks } from "./checks/zshrc.ts";
import { type DoctorCtx, makeContext } from "./context.ts";

/** The groups in report order: the order of the output is the order of this list. */
const GROUPS: ((ctx: DoctorCtx) => Promise<Check[]>)[] = [
  repoChecks,
  configChecks,
  sharedChecks,
  runtimeChecks,
  profileChecks,
  binariesChecks,
  updateLockChecks,
  stubChecks,
  zshrcChecks,
  syncthingChecks,
  gitIgnoreChecks,
  consoleChecks,
  mcpChecks,
  vaultChecks,
  mcpLegacyChecks,
  updateChecks,
  desktopChecks,
  appChecks,
  brainChecks,
  desktopPackagingChecks,
  loginChecks,
  agentsChecks,
];

/**
 * Runs every check group against this machine and returns the verdicts, in a stable order.
 *
 * @param opts.probe also spend one request per profile on its Claude Code login (`doctor --probe`)
 * @returns one `Check` per finding; a group that finds nothing wrong may add nothing.
 * @throws when the configuration cannot be read at all (no profiles directory); individual checks
 *   report their own failures as `fail` rather than throwing.
 */
export async function doctor(opts: { probe?: boolean } = {}): Promise<Check[]> {
  const ctx = await makeContext(opts);
  const out: Check[] = [];
  for (const group of GROUPS) out.push(...await group(ctx));
  return out;
}
