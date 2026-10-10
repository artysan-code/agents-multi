// close-plan.ts — what «Close Claude and update» is about: who holds the install, and the screen that
// shows it. Apart from updates-close.tsx so the shell can tell when to load that screen.

import { signal } from "@preact/signals";

export interface Blocker {
  key: string;
  pid: number;
  profile: string;
  embedded: boolean;
  busy: boolean | null;
  ageSec: number | null;
  protected: boolean;
}
export interface Plan {
  offer: boolean;
  /** the build or commit an install is waiting with; null when none is */
  pending: string | null;
  blockers: Blocker[];
}

/** The screen on show: the plan it was opened with. */
export const closeScreen = signal<{ plan: Plan; at: number } | null>(null);
