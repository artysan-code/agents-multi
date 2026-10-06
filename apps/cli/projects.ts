// projects.ts — the projects a task can belong to: the owner's own folders (~/work/acme/site,
// ~/personal/dnd/dragons-lair…), so the task board groups work the way the disk does.
//
// The roots are top-level folders of $HOME, from the tasks settings (`projectRoots`; by default
// personal, work, university). Below a root every folder is a node, down to three levels; a git
// repository is a leaf (its inside is code, not projects). A task's `project` is either such a path
// ("work/acme/site") or a bare name ("site", "acme") that resolves to the shallowest folder of that
// name; a name that matches no folder stays as it is and is grouped on its own.

import { loadSettings } from "../../shared/mcp/lib/tasks.ts";
import { HOME } from "./lib/paths.ts";

export interface ProjectNode {
  path: string;
  name: string;
  depth: number;
  repo: boolean;
}
const DEFAULT_ROOTS = ["personal", "work", "university"];
const SKIP = /^(\.|_|node_modules$|archive$|archivio$|backups?$)/i;
const MAX_DEPTH = 3, MAX_NODES = 600;

export async function projectTree(): Promise<ProjectNode[]> {
  const s = await loadSettings() as { projectRoots?: string[] };
  const roots = (s.projectRoots ?? DEFAULT_ROOTS).filter((r) => /^[\w.-]+$/.test(r));
  const out: ProjectNode[] = [];
  const walk = async (rel: string, depth: number) => {
    if (out.length >= MAX_NODES) return;
    const kids: string[] = [];
    try {
      for await (const e of Deno.readDir(`${HOME}/${rel}`)) if (e.isDirectory && !SKIP.test(e.name)) kids.push(e.name);
    } catch {
      return;
    }
    for (const name of kids.sort((a, b) => a.localeCompare(b))) {
      const path = `${rel}/${name}`;
      const repo = await Deno.stat(`${HOME}/${path}/.git`).then(() => true, () => false);
      out.push({ path, name, depth, repo });
      if (!repo && depth < MAX_DEPTH) await walk(path, depth + 1);
    }
  };
  for (const r of roots) {
    if (!(await Deno.stat(`${HOME}/${r}`).then((x) => x.isDirectory, () => false))) continue;
    out.push({ path: r, name: r, depth: 0, repo: false });
    await walk(r, 1);
  }
  return out;
}

/** Pure: the folder a task's project means — the path itself, or the shallowest folder with that
 *  name (case-insensitive); null when none matches. */
export function resolveProject(value: string | undefined, tree: ProjectNode[]): string | null {
  if (!value) return null;
  const v = value.trim().replace(/^~\//, "").replace(/\/+$/, "");
  if (tree.some((n) => n.path === v)) return v;
  const low = v.toLowerCase();
  const hits = tree.filter((n) => n.name.toLowerCase() === low).sort((a, b) =>
    a.depth - b.depth || a.path.localeCompare(b.path)
  );
  return hits[0]?.path ?? null;
}
