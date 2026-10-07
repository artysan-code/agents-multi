// runtime-root.ts — Where the runtime is, by name. It is ~/.agents-multi; before Agents Multi it was
// ~/.claude-multi, and a machine keeps it there until `agents migrate` moves it. Until then
// ~/.agents-multi is a link to the old folder (ensureRuntimeLink), so the hooks, servers and imports
// that name the new folder find it on a machine that has not moved yet; after the move the old name
// is the link, for the configurations and transcripts that still say it.
//
// Reads only what it is given: scripts/release.ts runs it with a narrow --allow-env.

export const RUNTIME_NAME = ".agents-multi";
export const LEGACY_RUNTIME_NAME = ".claude-multi";

function existsSync(p: string) {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The runtime under `home`: the new name when it exists or when neither does (a fresh machine),
 *  the old one while only that exists. */
export function runtimeRoot(home: string, exists: (p: string) => boolean = existsSync): string {
  const now = `${home}/${RUNTIME_NAME}`;
  return exists(now) || !exists(`${home}/${LEGACY_RUNTIME_NAME}`) ? now : `${home}/${LEGACY_RUNTIME_NAME}`;
}

/** Pure: the profile a Claude config directory belongs to, when it sits directly in the runtime
 *  under either name (a session started before the move still says the old one). */
export function profileOfConfigDir(configDir: string | undefined, runtime: string): string | undefined {
  const dir = configDir?.replace(/\/+$/, "");
  if (!dir) return undefined;
  const root = runtime.replace(/\/+$/, "");
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  const base = root.slice(0, root.lastIndexOf("/"));
  const roots = [root, `${base}/${RUNTIME_NAME}`, `${base}/${LEGACY_RUNTIME_NAME}`];
  return roots.includes(parent) ? dir.split("/").pop() : undefined;
}

/** On a machine not yet moved (~/.claude-multi a real folder, no ~/.agents-multi), make
 *  ~/.agents-multi a relative link to it. True when it made the link. */
export async function ensureRuntimeLink(home: string): Promise<boolean> {
  const now = `${home}/${RUNTIME_NAME}`;
  const old = await Deno.lstat(`${home}/${LEGACY_RUNTIME_NAME}`).catch(() => null);
  if (!old?.isDirectory || await Deno.lstat(now).then(() => true, () => false)) return false;
  await Deno.symlink(LEGACY_RUNTIME_NAME, now);
  return true;
}
