// Pure decision pieces of syncthing-status, kept apart from server.ts (which starts the server on import) so they can be tested.

/** Expand a leading `~` (Syncthing may report a folder path that way) to `home`. */
export function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") && home) return `${home}${p.slice(1)}`;
  return p;
}

/** Why the `/rest/db/status` of a folder cannot be trusted, or null when it can. */
export function dbStatusProblem(s: { error?: string; invalid?: string } | null): string | null {
  if (!s) return "no status returned";
  if (s.error) return s.error;
  if (s.invalid) return `invalid: ${s.invalid}`;
  return null;
}

export interface GitVerdict {
  /** The facts the verdict is drawn from. */
  gitDirSynced: boolean;
  /** Files tracked by git; null when `git ls-files` failed (see `trackedError`). */
  tracked: string[] | null;
  trackedError?: string;
  /** Tracked files that Syncthing does not ignore, among the ones inspected. */
  exposed: number;
  truncated: boolean;
}

/** The risk line of one repository. A failed `git ls-files` is never "OK": the partition is unknown. */
export function gitRisk(v: GitVerdict): string {
  if (v.gitDirSynced) return "🔴 CRITICAL — .git synced (repository corruption risk)";
  if (v.tracked === null) return `❔ ? — could not list tracked files: ${v.trackedError ?? "unknown error"}`;
  if (v.exposed > 0) {
    return `🟡 WARN — ${v.exposed}${
      v.truncated ? "+" : ""
    }/${v.tracked.length} tracked files synced (working-tree drift)`;
  }
  return "🟢 OK — correct partition (only valuable gitignored files synced)";
}
