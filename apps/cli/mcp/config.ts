// config.ts — the CLI's MCP servers, handed to Claude at launch instead of copied into its files.
// Per profile a generated `<runtime>/<profile>/mcp.json` (same shape as .mcp.json) that bin/claude passes
// with `--mcp-config`: Claude merges it over the servers of its own files, the project's `.mcp.json` and
// the plugins' (no --strict-mcp-config: those keep working), and it wins on a name clash. The file is ours
// and wholly generated, so there is nothing to keep in step with a file Claude rewrites, and no need to
// close a session to change it. It is rebuilt with the settings (settings.ts), when their inputs change.

import { readJson, writeAtomic } from "../lib/fs.ts";
import { RUNTIME } from "../lib/paths.ts";
import { profileNames } from "../lib/profiles.ts";
import { running } from "../lib/processes.ts";
import { backup, hasDesktop, loadState, saveState } from "./apply.ts";
import { launchServers, syncGateway } from "./gateway.ts";
import { servers } from "./placement.ts";
import { loadRegistry, type Registry } from "./registry.ts";

export const mcpConfigPath = (profile: string) => `${RUNTIME}/${profile}/mcp.json`;
/** What a Codex child may use of that config: per server, its `_allow` tools (shared/mcp/lib/codex.ts). */
export const codexToolsPath = (profile: string) => `${RUNTIME}/${profile}/mcp-codex.json`;

/** Pure: the file Codex children read beside the launch config. A Codex child never asks the owner, so it
 *  gets no tool the registry puts behind a question or a refusal: of each server only its `_allow` tools
 *  (its reads), and a server without any is not given. */
export function codexToolsConfig(reg: Registry, profile: string): string {
  const tools: Record<string, string[]> = {};
  for (const p of servers(reg, { profile, surface: "cli" })) {
    const allow = reg.servers[p.entry]._allow ?? [];
    if (allow.length) tools[p.name] = [...allow].sort();
  }
  return JSON.stringify({ tools }, null, 2) + "\n";
}

/** Pure: the file a profile's launcher passes, as text. */
export function launchConfig(reg: Registry, profile: string): string {
  return JSON.stringify({ mcpServers: launchServers(reg, profile) }, null, 2) + "\n";
}

/** Pure: `.claude.json` without the servers this setup once projected into it (by name: what the
 *  state recorded as managed). Hand-added servers and every other key stay as they are. */
export function withoutManaged<T extends { mcpServers?: Record<string, unknown> }>(
  conf: T,
  managed: string[],
): { conf: T; removed: string[] } {
  const current = conf.mcpServers ?? {};
  const removed = managed.filter((n) => n in current);
  if (!removed.length) return { conf, removed };
  const kept = Object.fromEntries(Object.entries(current).filter(([n]) => !removed.includes(n)));
  return { conf: { ...conf, mcpServers: kept }, removed };
}

/** Writes the profile's launch config when it differs from what the registry now says; true if it wrote. */
export async function syncLaunchConfig(profile: string, reg?: Registry): Promise<boolean> {
  const path = mcpConfigPath(profile);
  reg ??= await loadRegistry();
  // the gateway's token and configuration first: the config below points at them
  if (reg.gateway?.enabled) await syncGateway(reg);
  const text = launchConfig(reg, profile);
  const tools = codexToolsConfig(reg, profile);
  let wrote = false;
  for (const [file, body] of [[path, text], [codexToolsPath(profile), tools]]) {
    if (await Deno.readTextFile(file).catch(() => null) === body) continue;
    await writeAtomic(file, body);
    wrote = true;
  }
  return wrote;
}

/**
 * Once per profile, takes out of its `.claude.json` the servers the old projection put there (those
 * the state names, nothing else), now that the launch config carries them. A profile that has Desktop
 * keeps them: the Code tab's embedded Claude reads that file, and apply.ts maintains them. Skipped while a Claude of
 * the profile is open (it rewrites that file: the next run does it) and when the launch config is
 * not there yet (the servers would vanish from the profile).
 *
 * @returns the names removed, empty when there was nothing to do or it had to wait
 */
export async function retireProjection(profile: string): Promise<string[]> {
  const key = `cli:${profile}`;
  const state = await loadState();
  const managed = state[key];
  if (!managed || await hasDesktop(profile)) return [];
  if (!(await Deno.stat(mcpConfigPath(profile)).catch(() => null))) return [];
  const path = `${RUNTIME}/${profile}/.claude.json`;
  const conf = await readJson<{ mcpServers?: Record<string, unknown> }>(path);
  if (conf) {
    if ((await running()).cli.some((c) => c.profile === profile)) return [];
    const { conf: next, removed } = withoutManaged(conf, managed);
    if (removed.length) {
      await backup({ path, managedKey: key });
      await writeAtomic(path, JSON.stringify(next, null, 2) + "\n");
    }
    delete state[key];
    await saveState(state);
    return removed;
  }
  delete state[key];
  await saveState(state);
  return [];
}

/** The profiles (set up on this machine) whose launch config is missing or differs from what the
 *  registry now says. Not an error: the launcher rebuilds it before Claude starts. */
export async function staleLaunchConfigs(): Promise<string[]> {
  const reg = await loadRegistry();
  const out: string[] = [];
  for (const p of await profileNames()) {
    if (!(await Deno.stat(`${RUNTIME}/${p}`).catch(() => null))) continue;
    if (
      await Deno.readTextFile(mcpConfigPath(p)).catch(() => null) !== launchConfig(reg, p) ||
      await Deno.readTextFile(codexToolsPath(p)).catch(() => null) !== codexToolsConfig(reg, p)
    ) out.push(p);
  }
  return out;
}
