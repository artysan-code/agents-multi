// codeversion.ts — a fingerprint of the code the console runs: its server (cli/, the libraries it
// shares with the MCP servers) and its page (the build in apps/ui/dist). The console takes it when it starts and
// tells it to every page it serves (/api/code, and the first event of /api/events); a page that hears
// another one reloads itself, and the doctor compares it with the files as they are now: a console
// started before a pull or an edit is running old code, and says so instead of showing stale errors.

import { REPO } from "./lib/paths.ts";

const ROOTS = ["apps/cli", "shared/mcp/lib", "apps/ui/dist"];
const SKIP = /\/(tests|node_modules)(\/|$)/;

async function files(root: string, dir: string, out: string[]) {
  if (/\.(ts|js)$/.test(dir) && (await Deno.stat(`${root}/${dir}`).catch(() => null))?.isFile) {
    out.push(dir); // a root may name one file
    return;
  }
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
export async function codeVersion(root = REPO, roots: string[] = ROOTS): Promise<string> {
  const list: string[] = [];
  for (const r of roots) await files(root, r, list);
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

/** The gateway's own fingerprint: its code and the one library it imports, nothing of the console or the
 *  page. A console update that leaves the gateway alone leaves it running (and its calls in flight). */
export const gatewayCodeVersion = (root = REPO) => codeVersion(root, ["shared/mcp/gateway", "shared/mcp/lib/fs.ts"]);

/** Pure: the folder under shared/mcp a server's command runs (`…/shared/mcp/<dir>/server.ts`), or null for
 *  a command that is not one of ours. */
export function serverDirOf(args: string[]): string | null {
  for (const a of args) {
    const m = /\/shared\/mcp\/([\w-]+)\/server\.ts$/.exec(a);
    if (m) return m[1];
  }
  return null;
}

/** The fingerprint of one of our servers: its own folder and the libraries it shares. A change of the
 *  console, the page or another server leaves its cached tool list alone. */
export const serverCodeVersion = (dir: string, root = REPO) =>
  codeVersion(root, [`shared/mcp/${dir}`, "shared/mcp/lib"]);
