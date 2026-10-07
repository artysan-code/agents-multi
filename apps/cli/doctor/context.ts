// context.ts — what the check groups share, computed once per doctor run.

import { type Check, type RepairStep, type Status } from "../lib/output.ts";
import { readlink } from "../lib/fs.ts";
import { repoState } from "../lib/git.ts";
import { machine } from "../lib/machine.ts";
import { REPO, RUNTIME } from "../lib/paths.ts";
import { profileNames, sharedInventory } from "../lib/profiles.ts";

/** Facts read once and shared by several groups; each group still reads what only it needs. */
export interface DoctorCtx {
  /** the host: systemd, graphical session, Claude Code and Desktop versions */
  m: Awaited<ReturnType<typeof machine>>;
  /** git state of the repository */
  repo: Awaited<ReturnType<typeof repoState>>;
  /** the installed repository, the one the runtime's links point at (`installedRepo`); REPO is the
   *  code that is running, which can be another checkout */
  installed: string;
  /** the profiles the configuration declares */
  declared: string[];
  /** what shared/ holds, by kind */
  inv: Awaited<ReturnType<typeof sharedInventory>>;
  /** `agents doctor --probe`: also spend one request per profile on its login */
  probe: boolean;
}

/** Reads the shared facts. */
export async function makeContext(opts: { probe?: boolean }): Promise<DoctorCtx> {
  return {
    m: await machine(),
    repo: await repoState(),
    installed: installedRepo(await readlink(`${RUNTIME}/shared`), REPO),
    declared: await profileNames(),
    inv: await sharedInventory(),
    probe: !!opts.probe,
  };
}

/**
 * Pure: the installed repository, from where `~/.agents-multi/shared` points (`install` links it to
 * `<repository>/shared`). Without such a link — missing, a real folder, anything else — the running
 * code (`repo`) stands in, and the runtime check says what is wrong with the link.
 */
export function installedRepo(sharedLink: string | null, repo: string): string {
  return sharedLink?.startsWith("/") && sharedLink.endsWith("/shared") && sharedLink.length > "/shared".length
    ? sharedLink.slice(0, -"/shared".length)
    : repo;
}

/** A fresh check list and the `add` that appends to it (`fix` and `repair` are optional). */
export function checkList(): [
  Check[],
  (id: string, status: Status, msg: string, fix?: string, repair?: RepairStep[]) => void,
] {
  const c: Check[] = [];
  return [c, (id, status, msg, fix, repair) => c.push({ id, status, msg, fix, repair })];
}
