// stale.ts — which running parts of agents-multi a set of changed files leaves on old code. Pure, and
// free of the environment, so that scripts/release.ts can use it with git's permissions alone.

/** Pure: which running parts a set of changed files makes stale. */
export function staleParts(changed: string[]): { console: boolean; app: boolean } {
  return {
    console: changed.some((f) =>
      f.startsWith("apps/cli/") && !f.startsWith("apps/cli/tests/") || f.startsWith("shared/mcp/lib/")
    ),
    app: changed.some((f) => f.startsWith("apps/tray/")),
  };
}

/** Pure: the systemd user units to restart for a set of changed files; the console last, since it may
 *  be the one asking. */
export function staleUnits(changed: string[]): string[] {
  const s = staleParts(changed);
  return [s.app && "claude-multi-app.service", s.console && "claude-multi-console.service"].filter((
    u,
  ): u is string => !!u);
}
