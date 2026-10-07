// appstate.ts — what the desktop app and `install --app` leave in the state folder for the doctor:
// the build the app carries (written by the app at each start, apps/desktop/src-tauri/src/install.rs)
// and the result of the last `install --app` (appinstall.ts).

import { readJson } from "./fs.ts";
import { STATE } from "./paths.ts";

/** The result of the last `install --app`. */
export const INSTALL_RECORD = `${STATE}/app-install.json`;
/** The build the app carries, as it wrote it at its last start. */
export const APP_BUILD = `${STATE}/app-build.json`;

export interface InstallRecord {
  at: string;
  /** the build installed (or refused) */
  build: string;
  ok: boolean;
  /** install waited for Claude to be closed */
  pending?: boolean;
  error?: string;
}
export interface AppBuild {
  version: string;
  build: string;
}

export const readRecord = () => readJson<InstallRecord>(INSTALL_RECORD);
export const readAppBuild = () => readJson<AppBuild>(APP_BUILD);
