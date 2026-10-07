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

export const pickApi = {
  launchers: () => get<{ profiles: Launcher[] }>("/api/launch"),
  status: () => get<PickStatus>("/api/status"),
  launch: (profile: string) => post<Result>("/api/launch", { profile }),
};
