// plugins.ts — Plugin records: what an organisation syncs into a profile, and install records that went
// wrong.

import { listDir, readJson } from "./fs.ts";

/** Plugin names in one of Claude Code's sync manifests (plugins/synced/<uuid>/manifest.json). */
export function syncedPluginNames(manifest: unknown): string[] {
  const plugins = (manifest as { plugins?: unknown } | null)?.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.map((p) => (p as { name?: unknown })?.name).filter((n): n is string =>
    typeof n === "string" && n.length > 0
  );
}

/** Plugins the organisation syncs into a profile, as `<name>@synced` — the ids enabledPlugins takes.
 *  Mirrors cm_account_mcp_settings in bin/lib/profiles.sh. */
export async function syncedPlugins(dir: string): Promise<string[]> {
  const names = new Set<string>();
  for (const bucket of await listDir(`${dir}/plugins/synced`)) {
    for (const n of syncedPluginNames(await readJson(`${dir}/plugins/synced/${bucket}/manifest.json`))) {
      names.add(`${n}@synced`);
    }
  }
  return [...names].sort();
}

/** One record of installed_plugins.json, as far as the checks read it. */
export interface PluginRecord {
  scope?: string;
  installPath?: string;
  projectPath?: string;
}

/** The two ways an install record goes wrong. `exists` answers for the paths the records name.
 *  - broken: its cache directory is gone, so Claude lists the plugin as "failed to load". It happens
 *    when a profile directory is moved, since the records hold absolute paths.
 *  - stale: a project or local record whose project directory is gone. It loads nowhere, and
 *    `claude plugin uninstall --scope …` reaches it only from inside that directory.
 *  A stale record is not also broken: nothing would ever load it. */
export function pluginRecordState(plugins: Record<string, unknown>, exists: (path: string) => boolean) {
  const broken: string[] = [];
  const stale: { id: string; scope: string; project: string }[] = [];
  for (const [id, recs] of Object.entries(plugins)) {
    for (const r of Array.isArray(recs) ? recs as PluginRecord[] : []) {
      if ((r.scope === "project" || r.scope === "local") && r.projectPath && !exists(r.projectPath)) {
        stale.push({ id, scope: r.scope, project: r.projectPath });
      } else if (r.installPath && !exists(r.installPath) && !broken.includes(id)) broken.push(id);
    }
  }
  return { broken, stale };
}
