// api.ts — what «Which Claude?» reads and does: the profiles from GET /api/launch, the part of the
// report that says who each is signed in as, whose Desktop is open, how many Claude Code sessions each
// runs and whose sign-in has expired, the day's next appointment (optional), and POST /api/launch.

import { get, post, type Result } from "../../api.ts";
import type { Day } from "../today/api.ts";

export interface Launcher {
  profile: string;
  command: string;
}

/** The part of /api/status the picker reads. */
export interface PickStatus {
  language: string;
  profiles: Record<string, { account: string | null }>;
  running: { desktop: { variant: string }[]; cli: { profile: string }[] };
  doctor: { id: string; status: string }[];
}

export const pickApi = {
  launchers: () => get<{ profiles: Launcher[] }>("/api/launch"),
  status: () => get<PickStatus>("/api/status"),
  day: () => get<Day>("/api/tasks"),
  launch: (profile: string) => post<Result>("/api/launch", { profile }),
};
