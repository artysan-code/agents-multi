// api.ts — what the first-run wizard reads and sends: GET /api/setup (apps/cli/setup.ts's view) and the
// POSTs of its steps (apps/cli/console/setup.ts). A refused step answers 400 with its message, which
// is returned here as a result, not thrown.

import { get, postInit, type Result } from "../../api.ts";

export const STEPS = ["welcome", "you", "folder", "profiles", "install", "claude", "vault", "logins", "brain", "done"] as const;
export type Step = typeof STEPS[number];
export type VaultState = "ok" | "none" | "locked" | "wrong-key" | "unavailable";

export interface SetupProfile {
  profile: string;
  command: string;
  installed: boolean;
  signedIn: boolean;
}

export interface SetupView {
  active: true;
  step: Step;
  facts: {
    configured: boolean;
    owner: { id: string; name: string; language: string } | null;
    folder: string | null;
    profiles: SetupProfile[];
    installed: boolean;
    claudeCode: boolean;
    vault: VaultState;
    brain: { url: string | null; connected: boolean };
    record: {
      owner?: { name: string; language: string };
      passed: Step[];
      later: Step[];
      /** the configuration was made here: its profiles may be removed before install */
      created?: boolean;
      finished?: string;
    } | null;
  };
  suggested: string;
  install: "install-app" | "install";
  vaultDir: string;
}

/** A machine whose setup is over (or that was configured without the wizard) gets only `active: false`. */
export const loadSetup = () => get<SetupView | { active: false }>("/api/setup");

/** One step's POST: its answer, a refusal included. */
export async function send<T extends Result = Result>(path: string, body: unknown): Promise<T> {
  try {
    const r = await fetch(`/api/setup/${path}`, postInit(body));
    const j = await r.json().catch(() => ({ ok: false, message: String(r.status) }));
    return j as T;
  } catch (e) {
    return { ok: false, message: (e as Error).message } as T;
  }
}
