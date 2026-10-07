// api.ts — what «Which Claude?» reads and does: the profiles from GET /api/launch, the part of the
// report that says who each is signed in as and whose Desktop is open, and POST /api/launch.

import { get, post, type Result } from "../../api.ts";

export interface Launcher {
  profile: string;
  command: string;
}

/** The part of /api/status the picker reads: the account per profile, the Desktops running. */
export interface PickStatus {
  language: string;
  profiles: Record<string, { account: string | null }>;
  running: { desktop: { variant: string }[] };
}

/** The title that asks the desktop app to close the picker's window (`picker.rs` watches for it):
 *  the page has no IPC, and in a browser a title is harmless. */
export const CLOSE_TITLE = "agents-multi:close";

export const pickApi = {
  launchers: () => get<{ profiles: Launcher[] }>("/api/launch"),
  status: () => get<PickStatus>("/api/status"),
  launch: (profile: string) => post<Result>("/api/launch", { profile }),
};
