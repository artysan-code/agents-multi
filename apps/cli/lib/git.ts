// git.ts — The repository's git state, and git's global ignore file.

import { lstat } from "./fs.ts";
import { CACHE, HOME, REPO } from "./paths.ts";
import { run } from "./proc.ts";

/** What no repository on this machine ever commits, through git's global ignore: a project's
 *  binding of claude-multi's servers (shared/mcp/lib/launch.ts, BINDING_FILE). */
export const GIT_IGNORED = ["**/.claude/claude-multi.json"];

/** Pure: the patterns of `want` that an ignore file's text does not list yet. */
export const missingIgnores = (text: string, want: string[]) =>
  want.filter((p) => !text.split("\n").some((l) => l.trim() === p));

/** git's global ignore file: core.excludesFile, else the XDG default git reads without it. */
export async function gitGlobalIgnore(): Promise<string> {
  const set = (await run("git", ["config", "--global", "--get", "core.excludesFile"])).out;
  if (set) return set.replace(/^~(?=\/)/, HOME);
  return `${Deno.env.get("XDG_CONFIG_HOME") || `${HOME}/.config`}/git/ignore`;
}

export async function repoState() {
  const g = (...a: string[]) => run("git", ["-C", REPO, ...a]);
  const isRepo = (await g("rev-parse", "--git-dir")).code === 0;
  if (!isRepo) return { path: REPO, isRepo: false as const };
  const branch = (await g("rev-parse", "--abbrev-ref", "HEAD")).out;
  const upstream = (await g("rev-parse", "--abbrev-ref", "@{u}")).out || null;
  const remote = (await g("remote", "get-url", "origin")).out || null;
  let ahead = 0, behind = 0;
  if (upstream) {
    const c = (await g("rev-list", "--left-right", "--count", "@{u}...HEAD")).out.split(/\s+/);
    behind = Number(c[0] ?? 0);
    ahead = Number(c[1] ?? 0);
  }
  const dirtyFiles = (await g("status", "--porcelain")).out.split("\n").filter(Boolean);
  const head = (await g("log", "-1", "--format=%h %s")).out;
  const headDate = (await g("log", "-1", "--format=%cI")).out;
  const fetchStamp = await lstat(`${CACHE}/fetch.stamp`);
  const fetchedAt = fetchStamp?.mtime ? fetchStamp.mtime.toISOString() : null;
  return {
    path: REPO,
    isRepo: true as const,
    branch,
    upstream,
    remote,
    ahead,
    behind,
    dirty: dirtyFiles.length,
    dirtyFiles,
    head,
    headDate,
    fetchedAt,
  };
}
