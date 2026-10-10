// fs.ts — Filesystem reads that answer null instead of throwing: a missing file is an answer, not an
// error, for every check that reads one. readJson and writeAtomic are the servers' too (shared/mcp/lib/fs.ts).

export { readJson, writeAtomic } from "../../../shared/mcp/lib/fs.ts";

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

/** Replaces `link` with a symlink to `target`, by renaming a new link over it: no moment without a link. */
export async function swapLink(link: string, target: string) {
  const tmp = `${link}.tmp-${Deno.pid}`;
  await Deno.remove(tmp).catch(() => {});
  await Deno.symlink(target, tmp);
  await Deno.rename(tmp, link);
}
