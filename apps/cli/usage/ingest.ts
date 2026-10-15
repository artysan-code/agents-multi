// usage/ingest.ts — Claude Code's JSONL transcripts into the database, each file from where the
// last read stopped.

import type { DatabaseSync } from "node:sqlite";
import { costUsd, RUNTIME } from "./db.ts";

/** Profiles to ingest: every runtime directory that actually holds transcripts. Discovered rather
 *  than declared, so a profile added by hand (or one removed) is picked up without a code change. */
async function ingestProfiles(): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(RUNTIME)) {
      if (!e.isDirectory || e.name.startsWith(".")) continue;
      try {
        if ((await Deno.stat(`${RUNTIME}/${e.name}/projects`)).isDirectory) out.push(e.name);
      } catch { /* no transcripts here */ }
    }
  } catch { /* runtime missing */ }
  return out.sort();
}

interface Acc {
  input: number;
  output: number;
  cacheRead: number;
  cache5m: number;
  cache1h: number;
  model: string;
  ts: string;
  sidechain: boolean;
  agentId: string | null;
  agent: string;
  cwd: string | null;
  entrypoint: string | null;
  version: string | null;
  sessionId: string | null;
  turnId: string | null;
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(dir)) entries.push(e);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(p);
    else if (e.isFile && e.name.endsWith(".jsonl")) yield p;
  }
}

function projectOf(path: string, profile: string) {
  const base = `${RUNTIME}/${profile}/projects/`;
  if (!path.startsWith(base)) return null;
  return path.slice(base.length).split("/")[0] ?? null;
}

/** Where a transcript was read to: the byte after its last complete line, and the turn open there. */
export interface ReadState {
  readTo: number;
  turnId: string | null;
  turnUsed: boolean;
}

/** The whole transcript, read again from its first byte. */
export async function ingestFile(db: DatabaseSync, profile: string, path: string) {
  return (await ingestFrom(db, profile, path)).msgs;
}

/** Reads a transcript from `from.readTo` (the start when absent) to its last complete line, merging
 *  with what an earlier read left: a response written in chunks across the boundary keeps the
 *  per-field maximum, and the turn that was open goes on. A partial last line waits for the next read. */
export async function ingestFrom(db: DatabaseSync, profile: string, path: string, from?: ReadState) {
  const bytes = await readBytes(path, from?.readTo ?? 0);
  const end = completeEnd(bytes);
  const text = new TextDecoder().decode(bytes.subarray(0, end));
  const project = projectOf(path, profile);
  const inSub = path.includes("/subagents/");
  const msgs = new Map<string, Acc>();
  const spawns: { id: string; ts: string; type: string; desc: string; model: string; session: string | null }[] = [];
  // a turn runs from one human prompt to the next; it is what attributes cost to skills and commands
  let turnId: string | null = from?.turnId ?? null, turnUsed = from?.turnUsed ?? false;
  const tools = new Map<string, { turn: string; kind: string; name: string; ts: string; session: string | null }>();
  const rememberTool = (kind: string, name: string, ts: string, session: string | null) => {
    if (!turnId || !name) return;
    const k = `${turnId}|${kind}|${name}`;
    if (!tools.has(k)) tools.set(k, { turn: turnId, kind, name, ts, session });
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === "user" && !d.isSidechain && !inSub) {
      // a tool_result continues the turn, it is not a new prompt
      const c = (d.message as { content?: unknown } | undefined)?.content;
      const isToolResult = Array.isArray(c) && c.some((b) => (b as { type?: string }).type === "tool_result");
      if (isToolResult) continue;
      // consecutive prompts with no reply between them (a slash command is followed by its own
      // expansion) are one turn: splitting them would leave the command on a turn with no cost
      if (turnUsed || !turnId) {
        turnId = (d.uuid as string) ?? turnId;
        turnUsed = false;
      }
      const txt = typeof c === "string"
        ? c
        : Array.isArray(c)
        ? c.map((b) => (b as { text?: string }).text ?? "").join("\n")
        : "";
      const ts = String(d.timestamp ?? ""), sess = (d.sessionId as string) ?? null;
      for (const m of txt.matchAll(/<command-name>\s*([^<]+?)\s*<\/command-name>/g)) {
        rememberTool("command", m[1].replace(/^\//, ""), ts, sess);
      }
      continue;
    }
    if (d.type !== "assistant") continue;
    const m = d.message as
      | { id?: string; model?: string; usage?: Record<string, unknown>; content?: unknown[] }
      | undefined;
    if (!m?.usage || !m.id || !m.model || m.model === "<synthetic>") continue;
    const u = m.usage;
    const cc =
      (u.cache_creation as { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined) ??
        {};
    const cache5m = cc.ephemeral_5m_input_tokens ??
      (cc.ephemeral_1h_input_tokens == null ? Number(u.cache_creation_input_tokens ?? 0) : 0);
    const cache1h = cc.ephemeral_1h_input_tokens ?? 0;
    const sidechain = !!d.isSidechain || inSub;
    const attribution = typeof d.attributionAgent === "string" ? d.attributionAgent : null;
    const agent = attribution ?? (sidechain ? "subagent" : "main");
    const cur: Acc = {
      input: Number(u.input_tokens ?? 0),
      output: Number(u.output_tokens ?? 0),
      cacheRead: Number(u.cache_read_input_tokens ?? 0),
      cache5m,
      cache1h,
      model: m.model,
      ts: String(d.timestamp ?? ""),
      sidechain,
      agentId: (d.agentId as string) ?? null,
      agent,
      cwd: (d.cwd as string) ?? null,
      entrypoint: (d.entrypoint as string) ?? null,
      version: (d.version as string) ?? null,
      sessionId: (d.sessionId as string) ?? null,
      turnId,
    };
    turnUsed = true;
    const prev = msgs.get(m.id);
    if (prev) { // chunk of the same response: keep the per-field maximum
      prev.input = Math.max(prev.input, cur.input);
      prev.output = Math.max(prev.output, cur.output);
      prev.cacheRead = Math.max(prev.cacheRead, cur.cacheRead);
      prev.cache5m = Math.max(prev.cache5m, cur.cache5m);
      prev.cache1h = Math.max(prev.cache1h, cur.cache1h);
    } else msgs.set(m.id, cur);
    for (const b of m.content ?? []) {
      const blk = b as {
        type?: string;
        name?: string;
        id?: string;
        input?: { subagent_type?: string; description?: string; skill?: string };
      };
      if (blk.type !== "tool_use") continue;
      if ((blk.name === "Agent" || blk.name === "Task") && blk.id) {
        spawns.push({
          id: blk.id,
          ts: cur.ts,
          type: blk.input?.subagent_type ?? "general-purpose",
          desc: blk.input?.description ?? "",
          model: m.model,
          session: cur.sessionId,
        });
      }
      if (blk.name === "Skill" && blk.input?.skill) rememberTool("skill", blk.input.skill, cur.ts, cur.sessionId);
    }
  }
  if (!from) {
    db.prepare("DELETE FROM messages WHERE file = ?").run(path);
    db.prepare("DELETE FROM turn_tools WHERE file = ?").run(path);
  } else {
    const before = db.prepare(
      "SELECT input, output, cache_read, cache_5m, cache_1h FROM messages WHERE msg_id = ? AND file = ?",
    );
    for (const [id, a] of msgs) {
      const o = before.get(id, path) as
        | { input: number; output: number; cache_read: number; cache_5m: number; cache_1h: number }
        | undefined;
      if (!o) continue;
      a.input = Math.max(a.input, o.input);
      a.output = Math.max(a.output, o.output);
      a.cacheRead = Math.max(a.cacheRead, o.cache_read);
      a.cache5m = Math.max(a.cache5m, o.cache_5m);
      a.cache1h = Math.max(a.cache1h, o.cache_1h);
    }
  }
  const ins = db.prepare(`INSERT OR REPLACE INTO messages
    (msg_id, profile, project, session_id, file, sidechain, agent_id, agent, model, ts, day, input, output, cache_read, cache_5m, cache_1h, cost_usd, cwd, entrypoint, version, turn_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [id, a] of msgs) {
    ins.run(
      id,
      profile,
      project,
      a.sessionId,
      path,
      a.sidechain ? 1 : 0,
      a.agentId,
      a.agent,
      a.model,
      a.ts,
      a.ts.slice(0, 10),
      a.input,
      a.output,
      a.cacheRead,
      a.cache5m,
      a.cache1h,
      costUsd(a.model, a),
      a.cwd,
      a.entrypoint,
      a.version,
      a.turnId,
    );
  }
  const insT = db.prepare(
    `INSERT OR IGNORE INTO turn_tools (turn_id, kind, name, profile, project, session_id, file, ts, day) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const t of tools.values()) {
    insT.run(t.turn, t.kind, t.name, profile, project, t.session, path, t.ts, t.ts.slice(0, 10));
  }
  const insS = db.prepare(
    `INSERT OR REPLACE INTO agent_spawns (tool_use_id, profile, project, session_id, ts, day, subagent_type, description, model) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const s of spawns) insS.run(s.id, profile, project, s.session, s.ts, s.ts.slice(0, 10), s.type, s.desc, s.model);
  const state: ReadState = { readTo: (from?.readTo ?? 0) + end, turnId, turnUsed };
  return { msgs: msgs.size, bytes: end, state };
}

/** Pure: how many bytes of `bytes` are complete lines. A last line with no newline counts when it is
 *  whole JSON (a writer that does not end its file with one); a half-written one waits. */
export function completeEnd(bytes: Uint8Array): number {
  const nl = bytes.lastIndexOf(10) + 1;
  if (nl === bytes.length) return nl;
  try {
    JSON.parse(new TextDecoder().decode(bytes.subarray(nl)));
    return bytes.length;
  } catch {
    return nl;
  }
}

/** The file's bytes from `offset` on. */
async function readBytes(path: string, offset: number): Promise<Uint8Array> {
  if (!offset) return await Deno.readFile(path);
  using f = await Deno.open(path);
  await f.seek(offset, Deno.SeekMode.Start);
  const size = (await f.stat()).size - offset;
  const out = new Uint8Array(Math.max(size, 0));
  let got = 0;
  while (got < out.length) {
    const n = await f.read(out.subarray(got));
    if (n == null) break;
    got += n;
  }
  return out.subarray(0, got);
}

/** Derived-schema version: when it rises, already-read files must be re-read (derived data changed). */
const SCHEMA_VERSION = 2;

/** What `ingest` did: files read, messages found, files left alone, bytes read. */
export interface IngestResult {
  files: number;
  msgs: number;
  skipped: number;
  bytes: number;
}

/** Reads the transcripts into the database. Each file is read from where the last read stopped, so a
 *  session that grew by a few lines costs a few lines. `only`: the paths known to have changed (the
 *  console's watcher); the others are not even looked at. Without it every transcript is looked at. */
export async function ingest(db: DatabaseSync, opts: { full?: boolean; quiet?: boolean; only?: string[] } = {}) {
  const ver = (db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined)?.user_version ?? 0;
  const full = opts.full || ver < SCHEMA_VERSION;
  if (full && ver < SCHEMA_VERSION && !opts.quiet) {
    console.error(`schema usage ${ver} → ${SCHEMA_VERSION}: full re-read of the transcripts`);
  }
  type Known = {
    size: number;
    mtime: number;
    read_to: number | null;
    turn_id: string | null;
    turn_used: number | null;
  };
  const known = new Map<string, Known>();
  for (
    const r of db.prepare("SELECT path, size, mtime, read_to, turn_id, turn_used FROM files").all() as (Known & {
      path: string;
    })[]
  ) known.set(r.path, r);
  const res: IngestResult = { files: 0, msgs: 0, skipped: 0, bytes: 0 };
  const upFile = db.prepare(
    "INSERT OR REPLACE INTO files (path, profile, size, mtime, ingested_at, read_to, turn_id, turn_used) VALUES (?,?,?,?,?,?,?,?)",
  );
  const forget = (p: string) => {
    db.prepare("DELETE FROM messages WHERE file = ?").run(p);
    db.prepare("DELETE FROM turn_tools WHERE file = ?").run(p);
    db.prepare("DELETE FROM files WHERE path = ?").run(p);
  };
  const one = async (profile: string, path: string) => {
    let st: Deno.FileInfo;
    try {
      st = await Deno.stat(path);
    } catch {
      if (known.has(path)) forget(path); // a deleted session
      return;
    }
    const mtime = st.mtime?.getTime() ?? 0;
    const k = full ? undefined : known.get(path);
    if (k && k.size === st.size && k.mtime === mtime) {
      res.skipped++;
      return;
    }
    // resume only a file that grew past where it was read to; a shorter one was rewritten
    const from: ReadState | undefined = k && k.read_to != null && k.read_to > 0 && st.size >= k.read_to
      ? { readTo: k.read_to, turnId: k.turn_id, turnUsed: !!k.turn_used }
      : undefined;
    db.exec("BEGIN");
    try {
      const r = await ingestFrom(db, profile, path, from);
      upFile.run(
        path,
        profile,
        st.size,
        mtime,
        new Date().toISOString(),
        r.state.readTo,
        r.state.turnId,
        r.state.turnUsed ? 1 : 0,
      );
      db.exec("COMMIT");
      res.msgs += r.msgs;
      res.bytes += r.bytes;
    } catch (e) {
      db.exec("ROLLBACK");
      if (!opts.quiet) console.error(`  ! ${path}: ${(e as Error).message}`);
      return;
    }
    res.files++;
  };
  if (opts.only) {
    const prefix = `${RUNTIME}/`;
    for (const path of opts.only) {
      const profile = path.startsWith(prefix) ? path.slice(prefix.length).split("/")[0] : "";
      if (profile && path.endsWith(".jsonl") && path.includes("/projects/")) await one(profile, path);
    }
  } else {
    for (const profile of await ingestProfiles()) {
      for await (const path of walk(`${RUNTIME}/${profile}/projects`)) await one(profile, path);
    }
    // files that vanished (deleted sessions): drop their messages too
    for (const p of known.keys()) {
      try {
        await Deno.stat(p);
      } catch {
        forget(p);
      }
    }
  }
  if (ver < SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return res;
}
