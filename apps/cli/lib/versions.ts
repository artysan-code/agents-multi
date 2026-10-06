// versions.ts — Version comparison, Claude Desktop's user-space versions and the update log.

import { readText } from "./fs.ts";
import { STATE } from "./paths.ts";

/** Numeric comparison of dotted versions ("2.10.0" > "2.9.9"). */
export function cmpVersion(a: string, b: string): number {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Pure: Claude Desktop in user space, from the version directories present and the one `current`
 * points at. `staged` is a newer version extracted and waiting for every instance to close;
 * `previous` is the newest one below the current, the rollback target.
 */
export function desktopVersions(dirs: string[], current: string | null) {
  const vs = dirs.filter((d) => /^\d+(\.\d+)+$/.test(d)).sort(cmpVersion).reverse();
  const cur = current && vs.includes(current) ? current : null;
  return {
    current: cur,
    staged: vs.find((v) => !cur || cmpVersion(v, cur) > 0) ?? null,
    previous: cur ? vs.find((v) => cmpVersion(v, cur) < 0) ?? null : null,
  };
}

/** The last update results (bin/lib/updates.sh writes them), newest first. */
export async function updateLog(
  limit = 20,
): Promise<{ at: string; component: string; event: string; from: string; to: string; detail: string }[]> {
  const text = await readText(`${STATE}/updates.jsonl`) ?? "";
  return text.split("\n").filter(Boolean).slice(-limit).reverse().flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}
