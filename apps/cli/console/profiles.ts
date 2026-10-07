// profiles.ts — creating and editing a profile from the console (POST /api/profile): the manifest in
// the person's configuration, its server selection, then `install`.

import { listDir, readJson, readText } from "../lib/fs.ts";
import { CONFIG, PROFILES } from "../lib/paths.ts";
import { profileNames } from "../lib/profiles.ts";
import { rawRegistry, selectServers, writePersonRegistry } from "../mcp/registry.ts";
import { runAction } from "./actions.ts";

export interface ProfileBody {
  name?: string;
  description?: string;
  command?: string;
  alias?: string;
  desktopDir?: string;
  mcp?: string[];
  disableAccountMcp?: boolean;
}

/** Profile names become directory names and are interpolated into paths, so the shape is fixed
 *  here rather than sanitised later: lowercase, starts with a letter, no separators. */
export const NAME_RE = /^[a-z][a-z0-9_-]{1,30}$/;

/**
 * Write a profile's manifest (and, for a new one, its CLAUDE.md importing the person's rules) into
 * the person's configuration. Nothing is installed: the console's form and the first-run wizard each
 * run install when they are ready for it.
 */
export async function writeProfile(b: ProfileBody): Promise<{ error?: string; name: string; isNew: boolean }> {
  const name = String(b.name ?? "").trim();
  if (!NAME_RE.test(name)) {
    return {
      error: "name must be lowercase, start with a letter, and use only letters, digits, - or _",
      name,
      isNew: false,
    };
  }

  const dir = `${PROFILES}/${name}`;
  const manifestPath = `${dir}/profile.json`;
  const existing = await readJson<Record<string, unknown>>(manifestPath);
  const isNew = !existing;

  const manifest: Record<string, unknown> = {
    ...(existing ?? { skills: "all", agents: "all", commands: "all" }),
    description: b.description?.trim() || existing?.description || `Profile ${name}.`,
  };
  if (b.command?.trim()) manifest.command = b.command.trim();
  else delete manifest.command;
  if (b.alias?.trim()) manifest.alias = b.alias.trim();
  else delete manifest.alias;
  if (b.desktopDir?.trim()) manifest.desktopDir = b.desktopDir.trim();
  else delete manifest.desktopDir;
  if (b.disableAccountMcp !== undefined) {
    if (b.disableAccountMcp) manifest.disableAccountMcp = true;
    else delete manifest.disableAccountMcp;
  }

  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (isNew && !(await readText(`${dir}/CLAUDE.md`))) {
    // the person's rules, all of them, as the other profiles import them
    const rules = (await listDir(`${CONFIG}/rules`)).filter((f) => f.endsWith(".md")).map((f) =>
      `@~/.agents-multi/config/rules/${f}`
    ).join("\n");
    await Deno.writeTextFile(
      `${dir}/CLAUDE.md`,
      `# CLAUDE.md — ${name} profile\n\n${manifest.description}\n${rules ? `\n## Rules\n\n${rules}\n` : ""}`,
    );
  }
  return { name, isNew };
}

/**
 * Create or update a profile: write its manifest, point the MCP registry at it, then run
 * `install` to materialise the runtime. Every write lands in the person's configuration —
 * nothing here touches ~/.agents-multi directly.
 */
export async function saveProfile(b: ProfileBody): Promise<{ error?: string; message?: string; output?: string }> {
  const { error, name, isNew } = await writeProfile(b);
  if (error) return { error };

  if (Array.isArray(b.mcp)) await applyRegistrySelection(name, b.mcp);

  const r = await runAction("install", []);
  // install reports its own diagnosis, so a non-zero exit is surfaced as output rather than
  // swallowed: the manifest is already written and the user needs to see what install said.
  return {
    message: `${isNew ? "Created" : "Updated"} profile ${name}${r.code ? " — install reported problems" : ""}`,
    output: r.output,
  };
}

/** Reflect a profile's server selection into the person's servers.json. An absent `_profiles` means
 *  "every profile", so opting one out has to materialise the list rather than just remove a name. */
async function applyRegistrySelection(name: string, picked: string[]) {
  const reg = await rawRegistry().catch(() => null);
  if (!reg?.servers) return;
  const next = selectServers(reg, await profileNames(), name, picked);
  if (JSON.stringify(next) !== JSON.stringify(reg)) await writePersonRegistry(next);
}
