// paths.ts — Where things are: the repository, the runtime, the person's configuration, the XDG
// directories and the console's port. Every path is derived from the environment once, at import.

import { amEnv } from "../../../shared/mcp/lib/env.ts";
import { runtimeRoot } from "./runtime-root.ts";

export const HOME = Deno.env.get("HOME") ?? "";
/** The repository this file is in: a checkout, or the desktop app's copy in its resources, which mirrors
 *  its layout (docs/adr/0003) under a folder that can have a space (macOS: `Agents Multi.app`). */
export const REPO = decodeURIComponent(new URL("../../..", import.meta.url).pathname).replace(/\/$/, "");
export const RUNTIME = amEnv("ROOT") ?? runtimeRoot(HOME);
/** The person's own configuration (profiles, accounts, rules, preferences): a folder of theirs, outside
 *  the repository, that ~/.agents-multi/config links to (`agents init`). The repository is code. */
export const CONFIG = amEnv("CONFIG") ?? `${RUNTIME}/config`;
export const PROFILES = `${CONFIG}/profiles`;
export const BIN = `${HOME}/.local/bin`;
export const LIB = `${HOME}/.local/lib`;
export const CACHE = `${Deno.env.get("XDG_CACHE_HOME") ?? `${HOME}/.cache`}/claude-multi`;
export const STATE = `${Deno.env.get("XDG_STATE_HOME") ?? `${HOME}/.local/state`}/claude-multi`;
export const DATA = `${Deno.env.get("XDG_DATA_HOME") ?? `${HOME}/.local/share`}/claude-multi`;
/** The local console's port on 127.0.0.1 (`agents serve`). */
export const PORT = Number(amEnv("PORT") ?? 7331);
// stignore-gen runs only where Syncthing does; its git template is what init.templateDir points at.
export const SYNCTHING_CONFIG = `${HOME}/.local/state/syncthing/config.xml`;
/** The template's place in a repository: the doctor finds it in the installed one (DoctorCtx.installed). */
export const STIGNORE_GEN_TEMPLATE_IN_REPO = "shared/tools/stignore-gen/git-template";
export const STIGNORE_GEN_TEMPLATE = `${REPO}/${STIGNORE_GEN_TEMPLATE_IN_REPO}`;
export const AGENTS_SKILLS = `${HOME}/.agents/skills`; // where external tools (skills CLI) install skills
export const STAMP = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");

/** Reserved entries under RUNTIME that are not profiles. */
export const NON_PROFILE_DIRS = new Set(["shared", "marketplaces", "plugins", "config"]);

export function expandHome(p: string) {
  return p.startsWith("~/") ? `${HOME}/${p.slice(2)}` : p;
}
export function shortHome(p: string) {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}
