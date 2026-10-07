// mode.ts — the installation's mode, decided here (bin/lib/profiles.sh's cm_mode reads the same link):
//
//   app  the code is the desktop app's copy: ~/.agents-multi/shared → app/current/shared, where
//        app/current is a link to the copy of the build in use (app/<version>-<digest>, appcopy.ts)
//   dev  a checkout: ~/.agents-multi/shared → <checkout>/shared, an absolute link, as every install
//        made before 1.0
//
// The installation says which it is; only a machine with no runtime yet (no `shared`) takes it from
// the code that runs: a checkout installs dev, the app's code installs app.

import { lstat, readlink } from "./fs.ts";
import { REPO, RUNTIME } from "./paths.ts";

export type Mode = "app" | "dev";
/** The copies of the app's code, under the runtime. */
export const APP_DIR = "app";
/** What `shared` is in app mode: relative, so the runtime can move with its links. */
export const COPY_SHARED = `${APP_DIR}/current/shared`;

export interface Installation {
  mode: Mode;
  /** the code the installation's links point into: the copy (through app/current) or the checkout */
  code: string;
  /** no runtime link yet: the mode is the running code's */
  fresh: boolean;
}

/** Pure: the installation, from what `${runtime}/shared` links to (null: not a link, or missing) and
 *  the running code. */
export function modeOf(
  sharedLink: string | null,
  runtime: string,
  running: string,
  runningIsCheckout: boolean,
): Installation {
  const copy = `${runtime}/${APP_DIR}/current`;
  if (sharedLink === COPY_SHARED || sharedLink === `${runtime}/${COPY_SHARED}`) {
    return { mode: "app", code: copy, fresh: false };
  }
  if (sharedLink?.startsWith("/") && sharedLink.endsWith("/shared") && sharedLink.length > "/shared".length) {
    return { mode: "dev", code: sharedLink.slice(0, -"/shared".length), fresh: false };
  }
  return runningIsCheckout ? { mode: "dev", code: running, fresh: true } : { mode: "app", code: copy, fresh: true };
}

/** Whether a folder is a git checkout (a worktree's .git is a file). */
export async function isCheckout(dir: string): Promise<boolean> {
  return !!(await lstat(`${dir}/.git`));
}

/** This machine's installation. */
export async function installation(runtime = RUNTIME, running = REPO): Promise<Installation> {
  return modeOf(await readlink(`${runtime}/shared`), runtime, running, await isCheckout(running));
}
