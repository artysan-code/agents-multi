// git.ts — The repository's git state, and git's global ignore file.

import { currentVersion } from "./changelog.ts";
import { lstat } from "./fs.ts";
import { CACHE, HOME, REPO } from "./paths.ts";
import { run } from "./proc.ts";

/** What no repository on this machine ever commits, through git's global ignore: a project's
 *  binding of agents-multi's servers (shared/mcp/lib/launch.ts, BINDING_FILE). */
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
  // independent reads: one round of git processes, not eight in a row
  const [branch, upstream, remote, counts, status, head, headDate, fetchStamp] = await Promise.all([
    g("rev-parse", "--abbrev-ref", "HEAD").then((r) => r.out),
    g("rev-parse", "--abbrev-ref", "@{u}").then((r) => r.out || null),
    g("remote", "get-url", "origin").then((r) => r.out || null),
    g("rev-list", "--left-right", "--count", "@{u}...HEAD").then((r) => r.out.split(/\s+/)),
    g("status", "--porcelain").then((r) => r.out),
    g("log", "-1", "--format=%h %s").then((r) => r.out),
    g("log", "-1", "--format=%cI").then((r) => r.out),
    lstat(`${CACHE}/fetch.stamp`),
  ]);
  // without an upstream the count fails and says nothing
  const [behind, ahead] = upstream ? [Number(counts[0] ?? 0), Number(counts[1] ?? 0)] : [0, 0];
  const dirtyFiles = status.split("\n").filter(Boolean);
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
    version: await currentVersion(),
    fetchedAt,
  };
}
