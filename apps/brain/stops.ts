// stops.ts — the phone's stops waiting for a node (ADR 0014, third round, B): what the announce's reply carries
// (fleet.ts) and the Agents view asks for (runs.ts). Its own module so the two do not import each other.

import type { DatabaseSync } from "node:sqlite";

/** The stops waiting for a node, oldest first; the ones that expired before it picked them up are marked so. */
export function pendingStops(
  db: DatabaseSync,
  node: string,
  now: () => number = () => Date.now(),
): { run: string; expires: string; assertion: unknown }[] {
  db.prepare(
    "update run_stops set state = 'refused', why = 'it expired before the machine picked it up' where state = 'pending' and expires < ?",
  ).run(new Date(now()).toISOString());
  return (db.prepare(
    "select run, expires, assertion from run_stops where node = ? and state = 'pending' order by seq",
  ).all(node) as { run: string; expires: string; assertion: string }[]).map((r) => ({
    run: r.run,
    expires: r.expires,
    assertion: JSON.parse(r.assertion),
  }));
}
