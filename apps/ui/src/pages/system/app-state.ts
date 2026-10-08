// app-state.ts — where the desktop app's update stands, as the Updates tab says it: the string's key and
// its values, so the rule is tested apart from the strings (apps/cli/tests/ui_app_state_test.ts).

/** The fields of the app's status (shell/app-update.ts) the line reads: no import, so a test runs it
 *  without the page's libraries. */
export interface AppLine {
  state: string;
  available: { version: string } | null;
  progress?: number;
  error?: string;
  off?: string;
}

/** Pure: the key of the line that says where the app's update stands, and its values. */
export function appState(
  a: AppLine,
): { key: string; vars?: Record<string, string | number> } {
  if (a.off) {
    return a.off.startsWith("package-manager:")
      ? {
        key: "up.app.pm",
        vars: { m: a.off.slice("package-manager:".length) },
      }
      : { key: "up.app.off" };
  }
  const v = a.available?.version ?? "";
  switch (a.state) {
    case "checking":
      return { key: "up.app.checking" };
    case "downloading":
      return {
        key: "up.app.downloading",
        vars: { v, p: Math.round((a.progress ?? 0) * 100) },
      };
    case "ready":
      return v ? { key: "up.app.ready", vars: { v } } : { key: "up.uptodate" };
    case "installing":
    case "restarting":
      return { key: "up.app.installing", vars: { v } };
    case "error":
      return { key: "up.app.error", vars: { e: a.error ?? "" } };
    default:
      return { key: "up.uptodate" };
  }
}
