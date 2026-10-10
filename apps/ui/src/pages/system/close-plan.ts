// close-plan.ts — the screen «Close Claude and update» is on show in. Apart from updates-close.tsx so
// the shell can tell when to load that screen.

import { signal } from "@preact/signals";
import type { Plan } from "../../api.ts";

/** The screen on show: the plan it was opened with. */
export const closeScreen = signal<{ plan: Plan; at: number } | null>(null);
