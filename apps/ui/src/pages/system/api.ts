// api.ts — what the System pages read and write beyond the shared report: the permission rules, the
// profile form and the step that closes Claude
// before an install.

import { api, type Blocker, type ClosePurpose, get, post, type Result } from "../../api.ts";

/* ---------------- permissions ---------------- */

export type List = "allow" | "ask" | "deny";

export interface Permissions {
  mode: string;
  rules: Record<List, string[]>;
  profiles: Record<string, { mode?: string; lists: Record<string, { added: string[]; dropped: string[] }> }>;
}

export const loadPermissions = () => get<Permissions>("/api/permissions");

/** One change to the rules; a refusal is a result with a message. */
export const permissionOp = (body: Record<string, string>) =>
  post<{ ok: boolean; message?: string }>("/api/permissions", body).catch((e: Error) => ({
    ok: false,
    message: e.message,
  }));

/* ---------------- profiles ---------------- */

/** Writes the profile's manifest and runs install on the server. */
export const saveProfile = (body: unknown) => post<{ message?: string; output?: string; failed?: boolean }>("/api/profile", body);

/* ---------------- closing Claude before an install ---------------- */

export interface StepResult extends Result {
  reopen: string[];
  remaining: Blocker[];
}

/** Closes what holds the install (or, `mcp`, the MCP sync): TERM, or KILL as the second, explicit step. */
export const closeStep = (step: "term" | "kill", why: ClosePurpose = "install") =>
  post<StepResult>("/api/close-claude", { step, for: why });

/** Opens again a profile's Claude that the step closed; null when the server could not. */
export const reopenClaude = (profile: string) =>
  post<{ started?: string[] }>("/api/close-claude", { step: "reopen", profiles: [profile] }).catch(() => null);

/** The install that waited, run now. */
export const settleInstall = () => api.action("settle-install");
