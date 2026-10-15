// usage/db.ts — where the usage data lives: the paths, the list prices, and the SQLite database.

import { DatabaseSync } from "node:sqlite";
import { amEnv } from "../../../shared/mcp/lib/env.ts";
import { runtimeRoot, XDG_NAME, xdgBases } from "../lib/runtime-root.ts";

export const HOME = Deno.env.get("HOME") ?? "";
export const RUNTIME = amEnv("ROOT") ?? runtimeRoot(HOME);
const DATA = `${xdgBases((n) => Deno.env.get(n), HOME).data}/${XDG_NAME}`;
export const DB_PATH = `${DATA}/usage.db`;

// Listino Anthropic (skill claude-api, cache 2026-06-24), $/MTok. Cache: read 0.1×, write 5m 1.25×,
// write 1h 2× dell'input, salvo Fable 5/5.1 (read a 0.25 flat).
interface Rate {
  input: number;
  output: number;
  read?: number;
}
const RATES: [RegExp, Rate][] = [
  [/fable-5|mythos-5/, { input: 10, output: 50, read: 0.25 }],
  [/opus-5|opus-4-[5678]/, { input: 5, output: 25 }],
  [/opus-4/, { input: 15, output: 75 }],
  [/sonnet-5/, { input: 2, output: 10 }],
  [/sonnet-4/, { input: 3, output: 15 }],
  [/haiku-4-5/, { input: 1, output: 5 }],
  [/haiku-3-5/, { input: 0.8, output: 4 }],
];
function rateFor(model: string): Rate | null {
  for (const [re, r] of RATES) if (re.test(model)) return r;
  return null;
}
export function costUsd(
  model: string,
  u: { input: number; output: number; cacheRead: number; cache5m: number; cache1h: number },
) {
  const r = rateFor(model);
  if (!r) return null;
  const M = 1_000_000;
  return (u.input * r.input + u.output * r.output + u.cacheRead * (r.read ?? r.input * 0.1) +
    u.cache5m * r.input * 1.25 + u.cache1h * r.input * 2) / M;
}

export function openDb(path: string = DB_PATH) {
  if (path !== ":memory:") Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY, profile TEXT, size INTEGER, mtime REAL, ingested_at TEXT,
      read_to INTEGER, turn_id TEXT, turn_used INTEGER
    );
    CREATE TABLE IF NOT EXISTS messages (
      msg_id TEXT PRIMARY KEY, profile TEXT NOT NULL, project TEXT, session_id TEXT, file TEXT,
      sidechain INTEGER NOT NULL DEFAULT 0, agent_id TEXT, agent TEXT NOT NULL,
      model TEXT NOT NULL, ts TEXT NOT NULL, day TEXT NOT NULL,
      input INTEGER, output INTEGER, cache_read INTEGER, cache_5m INTEGER, cache_1h INTEGER,
      cost_usd REAL, cwd TEXT, entrypoint TEXT, version TEXT, turn_id TEXT
    );
    CREATE INDEX IF NOT EXISTS messages_profile_day ON messages(profile, day);
    CREATE INDEX IF NOT EXISTS messages_file ON messages(file);
    CREATE TABLE IF NOT EXISTS agent_spawns (
      tool_use_id TEXT PRIMARY KEY, profile TEXT, project TEXT, session_id TEXT, ts TEXT, day TEXT,
      subagent_type TEXT, description TEXT, model TEXT
    );
    CREATE TABLE IF NOT EXISTS turn_tools (
      turn_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      profile TEXT, project TEXT, session_id TEXT, file TEXT, ts TEXT, day TEXT,
      PRIMARY KEY (turn_id, kind, name)
    );
    CREATE INDEX IF NOT EXISTS turn_tools_kind ON turn_tools(kind, name);
    CREATE INDEX IF NOT EXISTS turn_tools_file ON turn_tools(file);
  `);
  // the billing monitor is gone, and its samples with it
  db.exec("DROP TABLE IF EXISTS credit_samples");
  // migration: databases created before per-turn attribution lack the column
  const cols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("turn_id")) db.exec("ALTER TABLE messages ADD COLUMN turn_id TEXT");
  // …and those before incremental reading lack where each file was read to (NULL: read it whole again)
  const fcols = (db.prepare("PRAGMA table_info(files)").all() as { name: string }[]).map((c) => c.name);
  if (!fcols.includes("read_to")) {
    db.exec("ALTER TABLE files ADD COLUMN read_to INTEGER; ALTER TABLE files ADD COLUMN turn_id TEXT;");
    db.exec("ALTER TABLE files ADD COLUMN turn_used INTEGER");
  }
  return db;
}
