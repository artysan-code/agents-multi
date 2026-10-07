// changelog.ts — what is new: the sections of CHANGELOG.md between two versions. The console's update
// wizard shows them after an update, and so does the notification after one the timer made.

import { readText } from "./fs.ts";
import { REPO } from "./paths.ts";

export interface Release {
  version: string;
  date: string;
  /** The section's Markdown under its heading: `### Added`, then `- **scope**: change (hash)` lines. */
  body: string;
}

/** Pure: compares two versions (X.Y.Z or X.Y.Z-beta.N); a beta comes before its stable version. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(v.trim());
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : [0, 0, 0, 0];
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** Pure: every section of a changelog, newest first, as written. */
export function releases(changelog: string): Release[] {
  const out: Release[] = [];
  const parts = changelog.split(/^## \[/m).slice(1);
  for (const p of parts) {
    const m = /^([^\]]+)\](?: - (\S+))?\n/.exec(p);
    if (!m) continue;
    out.push({ version: m[1], date: m[2] ?? "", body: p.slice(m[0].length).trim() });
  }
  return out;
}

/** Pure: the releases after `since` up to `upTo` included, newest first. Without `since`, `upTo` alone. */
export function releasesBetween(changelog: string, since: string | null, upTo: string): Release[] {
  return releases(changelog).filter((r) =>
    compareVersions(r.version, upTo) <= 0 && (since ? compareVersions(r.version, since) > 0 : r.version === upTo)
  );
}

/** Pure: the first `n` changes of some releases as plain lines (no scope markup, no hash), and how
 *  many more there are. */
export function highlights(rs: Release[], n: number): { lines: string[]; more: number } {
  const all = rs.flatMap((r) =>
    r.body.split("\n").filter((l) => l.startsWith("- ")).map((l) =>
      l.slice(2).replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\s*\([0-9a-f]{7,}\)$/, "")
    )
  );
  return { lines: all.slice(0, n), more: Math.max(0, all.length - n) };
}

/** The version of the code on disk (deno.json), or null outside a checkout. */
export async function currentVersion(): Promise<string | null> {
  try {
    return JSON.parse(await readText(`${REPO}/deno.json`) ?? "{}").version ?? null;
  } catch {
    return null;
  }
}

/** What is new since `since`, read from the repository's CHANGELOG.md. */
export async function whatsNew(since: string | null): Promise<{ version: string | null; releases: Release[] }> {
  const version = await currentVersion();
  if (!version) return { version, releases: [] };
  return { version, releases: releasesBetween(await readText(`${REPO}/CHANGELOG.md`) ?? "", since, version) };
}
