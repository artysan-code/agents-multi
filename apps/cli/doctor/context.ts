// context.ts — what the check groups share, computed once per doctor run.

import { type Check, type Status } from "../lib/output.ts";
import { repoState } from "../lib/git.ts";
import { machine } from "../lib/machine.ts";
import { profileNames, sharedInventory } from "../lib/profiles.ts";

/** Facts read once and shared by several groups; each group still reads what only it needs. */
export interface DoctorCtx {
  /** the host: systemd, graphical session, Claude Code and Desktop versions */
  m: Awaited<ReturnType<typeof machine>>;
  /** git state of the repository */
  repo: Awaited<ReturnType<typeof repoState>>;
  /** the profiles the configuration declares */
  declared: string[];
  /** what shared/ holds, by kind */
  inv: Awaited<ReturnType<typeof sharedInventory>>;
  /** `claude-multi doctor --probe`: also spend one request per profile on its login */
  probe: boolean;
}

/** Reads the shared facts. */
export async function makeContext(opts: { probe?: boolean }): Promise<DoctorCtx> {
  return {
    m: await machine(),
    repo: await repoState(),
    declared: await profileNames(),
    inv: await sharedInventory(),
    probe: !!opts.probe,
  };
}

/** A fresh check list and the `add` that appends to it (`fix` is optional). */
export function checkList(): [Check[], (id: string, status: Status, msg: string, fix?: string) => void] {
  const c: Check[] = [];
  return [c, (id, status, msg, fix) => c.push({ id, status, msg, fix })];
}
