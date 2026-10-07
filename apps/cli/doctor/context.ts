// context.ts — what the check groups share, computed once per doctor run.

import { type Check, type RepairStep, type Status } from "../lib/output.ts";
import { repoState } from "../lib/git.ts";
import { machine } from "../lib/machine.ts";
import { installation, type Mode } from "../lib/mode.ts";
import { profileNames, sharedInventory } from "../lib/profiles.ts";

/** Facts read once and shared by several groups; each group still reads what only it needs. */
export interface DoctorCtx {
  /** the host: systemd, graphical session, Claude Code and Desktop versions */
  m: Awaited<ReturnType<typeof machine>>;
  /** git state of the repository */
  repo: Awaited<ReturnType<typeof repoState>>;
  /** the installed code, the one the runtime's links point at (lib/mode.ts): the app's copy through
   *  ~/.agents-multi/app/current, or a checkout; REPO is the code that is running, which can be
   *  another checkout or the app's package */
  installed: string;
  /** the installation's mode: app (the app's copy) or dev (a checkout) */
  mode: Mode;
  /** the profiles the configuration declares */
  declared: string[];
  /** what shared/ holds, by kind */
  inv: Awaited<ReturnType<typeof sharedInventory>>;
  /** `agents doctor --probe`: also spend one request per profile on its login */
  probe: boolean;
}

/** Reads the shared facts. */
export async function makeContext(opts: { probe?: boolean }): Promise<DoctorCtx> {
  const inst = await installation();
  return {
    m: await machine(),
    repo: await repoState(),
    installed: inst.code,
    mode: inst.mode,
    declared: await profileNames(),
    inv: await sharedInventory(),
    probe: !!opts.probe,
  };
}

/** A fresh check list and the `add` that appends to it (`fix` and `repair` are optional). */
export function checkList(): [
  Check[],
  (id: string, status: Status, msg: string, fix?: string, repair?: RepairStep[]) => void,
] {
  const c: Check[] = [];
  return [c, (id, status, msg, fix, repair) => c.push({ id, status, msg, fix, repair })];
}
