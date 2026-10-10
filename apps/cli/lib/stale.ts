// stale.ts — whether a set of changed files leaves the running console on old code. Pure.

/** Pure: whether the console (and the page it serves) runs code that these changed files replace. */
export function consoleStale(changed: string[]): boolean {
  // the page too (apps/ui): a restart is what tells the open pages to reload onto the new build
  return changed.some((f) =>
    f.startsWith("apps/cli/") && !f.startsWith("apps/cli/tests/") || f.startsWith("shared/mcp/lib/") ||
    f.startsWith("apps/ui/")
  );
}
