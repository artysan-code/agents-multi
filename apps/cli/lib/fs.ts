// fs.ts — Filesystem reads that answer null instead of throwing: a missing file is an answer, not an
// error, for every check that reads one.

export async function lstat(p: string) {
  try {
    return await Deno.lstat(p);
  } catch {
    return null;
  }
}
export async function stat(p: string) {
  try {
    return await Deno.stat(p);
  } catch {
    return null;
  }
}
export async function readlink(p: string) {
  try {
    return await Deno.readLink(p);
  } catch {
    return null;
  }
}
export async function readText(p: string) {
  try {
    return await Deno.readTextFile(p);
  } catch {
    return null;
  }
}
export async function readJson<T = Record<string, unknown>>(p: string): Promise<T | null> {
  const t = await readText(p);
  if (t === null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}
export async function listDir(p: string) {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(p)) out.push(e.name);
  } catch { /* missing */ }
  return out.sort();
}
export function mode(st: Deno.FileInfo | null) {
  return st?.mode == null ? null : (st.mode & 0o777).toString(8);
}
