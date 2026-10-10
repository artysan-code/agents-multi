// runtime-root.ts — Where the runtime is, by name: ~/.agents-multi.
//
// Reads only what it is given: scripts/release.ts runs it with a narrow --allow-env.

export const RUNTIME_NAME = ".agents-multi";

/** The runtime under `home`. */
export function runtimeRoot(home: string): string {
  return `${home}/${RUNTIME_NAME}`;
}

/** Pure: the profile a Claude config directory belongs to, when it sits directly in the runtime. */
export function profileOfConfigDir(configDir: string | undefined, runtime: string): string | undefined {
  const dir = configDir?.replace(/\/+$/, "");
  if (!dir) return undefined;
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  return parent === runtime.replace(/\/+$/, "") ? dir.split("/").pop() : undefined;
}

/** The folder of ours under each XDG base (cache, state, data). */
export const XDG_NAME = "agents-multi";

/** The XDG bases, from the environment as the XDG spec gives them. */
export function xdgBases(get: (n: string) => string | undefined, home: string) {
  return {
    cache: get("XDG_CACHE_HOME") || `${home}/.cache`,
    state: get("XDG_STATE_HOME") || `${home}/.local/state`,
    data: get("XDG_DATA_HOME") || `${home}/.local/share`,
  };
}
