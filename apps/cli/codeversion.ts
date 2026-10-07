// codeversion.ts — a fingerprint of the code the console runs: its server (cli/, the libraries it
// shares with the MCP servers) and its page (the build in apps/ui/dist). The console takes it when it starts and
// tells it to every page it serves (/api/code, and the first event of /api/events); a page that hears
// another one reloads itself, and the doctor compares it with the files as they are now: a console
// started before a pull or an edit is running old code, and says so instead of showing stale errors.

import { REPO } from "./lib/paths.ts";

const ROOTS = ["apps/cli", "shared/mcp/lib", "apps/ui/dist"];
const SKIP = /\/(tests|node_modules)(\/|$)/;

async function files(root: string, dir: string, out: string[]) {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(`${root}/${dir}`)];
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = `${dir}/${e.name}`;
    if (SKIP.test(`/${rel}`)) continue;
    if (e.isDirectory) await files(root, rel, out);
    else if (e.isFile && /\.(ts|js|css|html|svg)$/.test(e.name)) out.push(rel);
  }
}

/** The fingerprint of the code as it is on disk now (the running code's, unless `root` names another
 *  checkout): twelve hex characters. */
export async function codeVersion(root = REPO): Promise<string> {
  const list: string[] = [];
  for (const r of ROOTS) await files(root, r, list);
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (const f of list) {
    parts.push(enc.encode(`${f}\0`));
    parts.push(await Deno.readFile(`${root}/${f}`).catch(() => new Uint8Array()));
    parts.push(enc.encode("\0"));
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
  return [...h.slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
