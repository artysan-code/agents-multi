// api.ts — what the System pages read and write beyond the shared report: the permission rules, the
// plugins (table, catalog, one operation at a time), the profile form and the step that closes Claude
// before an install.

import { api, type Blocker, get, post, type Result } from "../../api.ts";

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

/* ---------------- plugins ---------------- */

/** One profile's view of a plugin: `override` is what that profile's own settings say (none = inherits). */
export interface Cell {
  enabled: boolean;
  installed: boolean;
  broken?: boolean;
  version?: string;
  override?: boolean | null;
}
interface PluginRow {
  id: string;
  name: string;
  marketplace: string;
  synced?: boolean;
  shared?: boolean | null;
  profiles: Record<string, Cell>;
}
interface Marketplace {
  name: string;
  source: string;
  declared: boolean;
  known: string[];
}
export interface PluginsView {
  profiles: string[];
  plugins: PluginRow[];
  marketplaces: Marketplace[];
  syncedSkills: Record<string, string[]>;
}
export interface CatEntry {
  id: string;
  name: string;
  marketplace: string;
  description: string;
  installs?: number;
}
export interface Catalog {
  total: number;
  entries: CatEntry[];
  marketplaces: string[];
}
interface OpResult {
  ok: boolean;
  message: string;
  log?: string[];
  confirm?: { command: string; sha256: string };
}
export type PluginBody = Record<string, unknown>;

export const loadPluginsView = (fresh = false) => get<PluginsView>("/api/plugins" + (fresh ? "?fresh" : ""));
export const loadCatalogPage = (qs: URLSearchParams) => get<Catalog>("/api/plugins/catalog?" + qs);
export const pluginOp = (body: PluginBody) => post<OpResult>("/api/plugins", body);
export const pluginDetails = (id: string) =>
  get<{ text?: string }>(`/api/plugins/details?id=${encodeURIComponent(id)}`);

/* ---------------- profiles ---------------- */

/** Writes the profile's manifest and runs install on the server. */
export const saveProfile = (body: unknown) => post<{ message?: string; output?: string }>("/api/profile", body);

/* ---------------- closing Claude before an install ---------------- */

export interface StepResult extends Result {
  reopen: string[];
  remaining: Blocker[];
}

/** Closes what holds the install: TERM, or KILL as the second, explicit step. */
export const closeStep = (step: "term" | "kill") => post<StepResult>("/api/close-claude", { step });

/** Opens again a profile's Claude that the step closed; null when the server could not. */
export const reopenClaude = (profile: string) =>
  post<{ started?: string[] }>("/api/close-claude", { step: "reopen", profiles: [profile] }).catch(() => null);

/** The install that waited, run now. */
export const settleInstall = () => api.action("settle-install");
