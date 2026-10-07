// profiles.ts — Profiles: their manifests (config/profiles/<p>/profile.json), launchers, Desktop data
// directories, what install mounted into each runtime directory, and the shared inventory.

import { listDir, lstat, mode, readJson, readlink, stat } from "./fs.ts";
import { AGENTS_SKILLS, CONFIG, expandHome, HOME, NON_PROFILE_DIRS, PROFILES, REPO, RUNTIME } from "./paths.ts";
import { type PluginRecord, pluginRecordState, syncedPlugins } from "./plugins.ts";

export type Profile = string;

export interface Manifest {
  description?: string;
  /** "all" = symlink the whole shared directory; a list = real directory with selective symlinks
   *  (plus whatever the profile owns) */
  skills: "all" | string[];
  agents: "all" | string[];
  commands: "all" | string[];
  /** Claude Desktop user-data-dir. Omitted = derived by convention, see desktopDir(). */
  desktopDir?: string;
  /** Launcher command that starts this profile. Omitted = `claude-<name>`, see commandOf(). */
  command?: string;
  /** Shell alias for the launcher, written into the managed ~/.zshrc block. */
  alias?: string;
  /** Switch off what the account brings in: the claude.ai connectors and the organisation's synced
   *  plugins. Applied by the launchers (bin/claude, bin/claude-launch), not by install. */
  disableAccountMcp?: boolean;
  /** A work profile on an account others administer: of the owner's brain it sees only the tasks of
   *  these projects (comma-separated folder prefixes, `work/acme`), and no memory pages. Its
   *  conversations belong to that account, so nothing personal goes into them. */
  brainScope?: string;
}
const MANIFEST_DEFAULT: Manifest = { skills: "all", agents: "all", commands: "all" };

export async function loadManifest(p: Profile): Promise<Manifest> {
  const m = await readJson<Partial<Manifest>>(`${PROFILES}/${p}/profile.json`);
  return { ...MANIFEST_DEFAULT, ...(m ?? {}) };
}

/** Profiles declared in the person's configuration — the source of truth. Any directory holding a profile.json. */
export async function profileNames(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (const n of await listDir(PROFILES)) {
    if (n.startsWith(".")) continue;
    if (await stat(`${PROFILES}/${n}/profile.json`)) out.push(n);
  }
  return out;
}

/** The command that launches a profile. The manifest wins; otherwise `claude-<name>`, which is
 *  what a profile added by hand gets without having to say so. */
export function commandOf(p: Profile, m: Manifest): string {
  return m.command?.trim() || `claude-${p}`;
}

/** Every declared profile with its launcher command and optional alias, in profile order.
 *  The launcher is one script (bin/claude) linked under each command name: it identifies its
 *  profile from the name it was invoked as, so a new profile needs no new file. */
export async function launchers(): Promise<{ profile: Profile; command: string; alias?: string }[]> {
  const out: { profile: Profile; command: string; alias?: string }[] = [];
  for (const p of await profileNames()) {
    const m = await loadManifest(p);
    out.push({ profile: p, command: commandOf(p, m), alias: m.alias?.trim() || undefined });
  }
  return out;
}

/** Profiles materialised under RUNTIME. Used to spot leftovers the repo no longer declares. */
export async function runtimeProfiles(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (const n of await listDir(RUNTIME)) {
    if (n.startsWith(".") || NON_PROFILE_DIRS.has(n)) continue;
    const st = await lstat(`${RUNTIME}/${n}`);
    if (st?.isDirectory) out.push(n);
  }
  return out;
}

/** Claude Desktop data dir for a profile: manifest wins, otherwise convention.
 *  `~/.config/Claude-<Name>` when it exists, else `~/.config/Claude` (Desktop's own default). */
export async function desktopDir(p: Profile, manifest?: Manifest): Promise<string> {
  const m = manifest ?? await loadManifest(p);
  if (m.desktopDir) return expandHome(m.desktopDir);
  const suffixed = `${HOME}/.config/Claude-${p.charAt(0).toUpperCase()}${p.slice(1)}`;
  return (await lstat(suffixed)) ? suffixed : `${HOME}/.config/Claude`;
}

/** Profiles that need a Desktop build of their own: a data dir other than Desktop's default (the same
 *  rule as `cm_desktop_appid` in bin/lib/profiles.sh). */
export async function variantProfiles(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (const p of await profileNames()) if (await desktopDir(p) !== `${HOME}/.config/Claude`) out.push(p);
  return out;
}

export const KINDS = ["skills", "agents", "commands"] as const;
export type Kind = typeof KINDS[number];
/** Items the profile owns for a kind (profiles/<p>/<kind>/*), always mounted. */
export async function ownItems(p: Profile, kind: Kind) {
  return await listDir(`${PROFILES}/${p}/${kind}`);
}

export async function profileInfo(p: Profile) {
  const dir = `${RUNTIME}/${p}`;
  const link = async (name: string) => await readlink(`${dir}/${name}`);
  const conf = await readJson<{ mcpServers?: Record<string, unknown>; oauthAccount?: { emailAddress?: string } }>(
    `${dir}/.claude.json`,
  );
  const plugins = await readJson<{ plugins?: Record<string, unknown> }>(`${dir}/plugins/installed_plugins.json`);
  const present = new Set<string>();
  for (const recs of Object.values(plugins?.plugins ?? {})) {
    for (const r of Array.isArray(recs) ? recs as PluginRecord[] : []) {
      for (const path of [r.installPath, r.projectPath]) if (path && await lstat(path)) present.add(path);
    }
  }
  const { broken: brokenPlugins, stale: stalePlugins } = pluginRecordState(
    plugins?.plugins ?? {},
    (path) => present.has(path),
  );
  const creds = await lstat(`${dir}/.credentials.json`);
  const manifest = await loadManifest(p);
  const mounted: Record<Kind, Record<string, { link: string | null; broken: boolean }>> = {
    skills: {},
    agents: {},
    commands: {},
  };
  const kindLinks: Record<Kind, string | null> = { skills: null, agents: null, commands: null };
  for (const k of KINDS) {
    kindLinks[k] = await link(k);
    for (const n of await listDir(`${dir}/${k}`)) {
      if (k !== "skills" && !n.endsWith(".md")) continue;
      const path = `${dir}/${k}/${n}`;
      // "mounted" is what install put there, i.e. symlinks. Whatever Claude Code writes into the
      // runtime itself (skills/synced/<uuid>/, an agent created in session) is the profile's own
      // content: the manifest does not claim it and the checks must not read it as a stray mount.
      const link = await readlink(path);
      if (link === null) continue;
      mounted[k][k === "skills" ? n : n.slice(0, -3)] = {
        link,
        broken: !(await stat(k === "skills" ? `${path}/SKILL.md` : path)),
      };
    }
  }
  const deskDir = await desktopDir(p, manifest);
  const desktopConf = await readJson<{ mcpServers?: Record<string, unknown> }>(`${deskDir}/claude_desktop_config.json`);
  return {
    dir,
    exists: !!(await lstat(dir)),
    desktopDir: deskDir,
    manifest,
    claudeMd: await link("CLAUDE.md"),
    settings: await link("settings.json"),
    hooks: await link("hooks"),
    kindLinks,
    mounted,
    credentials: creds ? { present: true, mode: mode(creds) } : { present: false, mode: null },
    account: conf?.oauthAccount?.emailAddress ?? null,
    mcp: Object.keys(conf?.mcpServers ?? {}),
    mcpDesktop: Object.keys(desktopConf?.mcpServers ?? {}),
    /** false until this profile's Desktop has been opened once: no config to apply servers to yet */
    desktopConfig: !!desktopConf,
    plugins: Object.keys(plugins?.plugins ?? {}),
    brokenPlugins,
    stalePlugins,
    synced: await syncedPlugins(dir),
  };
}

export async function sharedInventory() {
  const items = async (kind: Kind) => {
    const out: Record<string, { link: string | null; broken: boolean }> = {};
    for (const n of await listDir(`${REPO}/shared/${kind}`)) {
      if (kind !== "skills" && (!n.endsWith(".md") || n === "AGENTS.md")) continue;
      const path = `${REPO}/shared/${kind}/${n}`;
      out[kind === "skills" ? n : n.slice(0, -3)] = {
        link: await readlink(path),
        broken: !(await stat(kind === "skills" ? `${path}/SKILL.md` : path)),
      };
    }
    return out;
  };
  return {
    skills: await items("skills"),
    agents: await items("agents"),
    commands: await items("commands"),
    hooks: (await listDir(`${REPO}/shared/hooks`)).filter((f) => /\.(sh|js|py)$/.test(f)),
    rules: (await listDir(`${CONFIG}/rules`)).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")),
    agentsSkills: await listDir(AGENTS_SKILLS),
  };
}
