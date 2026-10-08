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

/** The folder of ours under each XDG base (cache, state, data); before Agents Multi it was the old name. */
export const XDG_NAME = "agents-multi";
export const LEGACY_XDG_NAME = "claude-multi";

/** The XDG bases, from the environment as the XDG spec gives them. */
export function xdgBases(get: (n: string) => string | undefined, home: string) {
  return {
    cache: get("XDG_CACHE_HOME") || `${home}/.cache`,
    state: get("XDG_STATE_HOME") || `${home}/.local/state`,
    data: get("XDG_DATA_HOME") || `${home}/.local/share`,
  };
}

/**
 * Moves each base's folder under the old name to the new one, and leaves the old name as a relative
 * link to it, for the code that still says it (a build before the move, a session's hooks, a rollback).
 * When both are folders — something wrote under the new name first — what only the old one has moves
 * over, and the rest stays aside in `claude-multi.pre-agents-multi`, never deleted. Says what it moved.
 */
export async function moveXdgDirs(bases: string[]): Promise<string[]> {
  const moved: string[] = [];
  const has = (p: string) => Deno.lstat(p).then(() => true, () => false);
  for (const base of bases) {
    const old = `${base}/${LEGACY_XDG_NAME}`;
    const now = `${base}/${XDG_NAME}`;
    if (!(await Deno.lstat(old).catch(() => null))?.isDirectory) continue; // absent, or already the link
    try {
      if (!(await has(now))) await Deno.rename(old, now);
      else {
        let left = 0;
        for await (const e of Deno.readDir(old)) {
          if (await has(`${now}/${e.name}`)) left++;
          else await Deno.rename(`${old}/${e.name}`, `${now}/${e.name}`);
        }
        if (left) await Deno.rename(old, `${old}.pre-${XDG_NAME}`);
        else await Deno.remove(old);
      }
      await Deno.symlink(XDG_NAME, old);
      moved.push(old);
    } catch {
      // another process moved it at the same moment, or the base is not ours to write: the next run retries
    }
  }
  return moved;
}
