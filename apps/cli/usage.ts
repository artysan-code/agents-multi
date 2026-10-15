// usage.ts — token counts and list-price estimates per profile / model / project / agent.
//
// Source: Claude Code's JSONL transcripts (~/.agents-multi/<profile>/projects/**).
// Every `assistant` line carries `message.usage` (input, output, cache read, cache write 5m/1h) and
// `message.model`. Lines sharing a `message.id` are chunks of one response and are counted once.
// Subagents live in <session>/subagents/**/agent-*.jsonl and in lines flagged `isSidechain`;
// `attributionAgent` (e.g. "workflow-subagent") labels them when present.
//
// DB: SQLite through node:sqlite (built into Deno, zero dependencies), per-machine under XDG data.
// Incremental ingest: a file is looked at only when its size or mtime changes, and read from where the
// last read stopped.
//
// Costs here are the LIST-PRICE EQUIVALENT (a Max subscription is not billed per token): useful to
// compare profiles, models and days, never for accounting — and nothing here raises an alert.
//
// Attributing to skills and commands: a skill consumes no tokens by itself, it makes the turn that
// uses it consume them. The turn is the well-defined unit available (from one human prompt to the
// next), so the turn's cost is split evenly across the skills/commands appearing in it: `uses`
// counts invocations, `cost` is the share. A declared approximation, not a direct measurement.
//
// The code is in usage/: db (paths, prices, SQLite), ingest, report, print. This file is the one place
// the rest of the CLI imports it from.

export { costUsd, DB_PATH, openDb } from "./usage/db.ts";
export { completeEnd, ingest, ingestFile, ingestFrom } from "./usage/ingest.ts";
export type { IngestResult, ReadState } from "./usage/ingest.ts";
export { projectLabel, report, sessions, sinceDate } from "./usage/report.ts";
export type { GroupBy } from "./usage/report.ts";
export { printReport } from "./usage/print.ts";
