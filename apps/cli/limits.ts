// limits.ts — `agents limits [--json]`: every account (a profile's Claude, its Codex where it has one) with
// the usage windows still running, read the passive way (shared/mcp/lib/limits.ts): the status line's
// snapshots and Codex's session logs. Nothing asks a vendor; to refresh Claude's, Today › Claude now.

import { type Account, allLimits } from "../../shared/mcp/lib/providers.ts";
import type { Window } from "../../shared/mcp/lib/limits.ts";
import { CONFIG, RUNTIME, STATE } from "./lib/paths.ts";

export interface AccountView {
  account: Account;
  windows: Window[];
}

/** Pure: a reset as "in 2h 10m" / "in 3d 4h", or "now". */
export function inHours(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "—";
  const s = Math.max(0, Math.round(resetsAt - now));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `in ${d}d ${h}h`;
  if (h) return `in ${h}h ${m}m`;
  return m ? `in ${m}m` : "now";
}

/** Pure: the table a person reads, one line per window, and a line for an account with none. */
export function limitsTable(all: AccountView[], now: number): string[] {
  const rows: string[][] = [];
  for (const { account, windows } of all) {
    if (!windows.length) rows.push([account.id, "—", "no reading", "", ""]);
    for (const w of windows) {
      rows.push([
        account.id,
        w.window,
        `${Math.round(w.usedPercent)}%`,
        `resets ${inHours(w.resetsAt, now)}`,
        w.source,
      ]);
    }
  }
  const width = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => r.map((c, i) => (i < 4 ? c.padEnd(width[i]) : c)).join("  ").trimEnd());
}

export async function limitsCommand(args: string[]): Promise<number> {
  const rest = args.filter((a) => a !== "--json");
  if (rest.length) {
    console.log(
      "agents limits [--json]   every account's usage windows (5h, 7d…), from the status line and Codex's logs",
    );
    return 2;
  }
  const now = Math.round(Date.now() / 1000);
  const all = await allLimits({ config: CONFIG, runtime: RUNTIME, live: `${STATE}/live` }, now);
  if (args.includes("--json")) console.log(JSON.stringify(all, null, 2));
  else if (!all.length) console.log("no profiles");
  else console.log(limitsTable(all, now).join("\n"));
  return 0;
}
