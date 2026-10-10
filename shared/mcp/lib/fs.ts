// fs.ts — the small file helpers the servers and the CLI share: a JSON file that may be missing, and a
// write that never leaves half a file behind.

/** A JSON file's contents, or null when it is missing or not valid JSON. */
export async function readJson<T = Record<string, unknown>>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path)) as T;
  } catch {
    return null;
  }
}

/**
 * Writes `data` to a temporary file beside `path` and renames it over: a crash (or Syncthing looking
 * in between) sees the old file or the new one, never half of one. With `mode` the file gets exactly
 * that permission, whatever the umask; without it, the default for a new file.
 */
export async function writeAtomic(path: string, data: string | Uint8Array, opts: { mode?: number } = {}) {
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    if (typeof data === "string") await Deno.writeTextFile(tmp, data, opts);
    else await Deno.writeFile(tmp, data, opts);
    if (opts.mode !== undefined) await Deno.chmod(tmp, opts.mode);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}

/** A queue that runs jobs one at a time, whatever one job's failure: a read-modify-write of the same
 *  file from two calls at once would otherwise lose one of them. */
export function serializer(): <T>(job: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const next = chain.then(job, job);
    chain = next.catch(() => {});
    return next;
  };
}
