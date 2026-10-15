// chats.ts — the conversations with Claude from the console (the Chat page, the Hey window): one file per
// chat in the state folder, written by the backend as each answer ends (ask.ts), so a chat is the same in
// every window and survives a restart. A chat holds what was asked and answered, the changes Claude made,
// and the Claude Code session the next request resumes.

import { readJson, writeAtomic } from "./lib/fs.ts";
import { STATE } from "./lib/paths.ts";

/** A tool Claude called while answering: its kind (tasks, calendar…), its name, and for a change what it was on. */
export interface Act {
  k: string;
  n: string;
  d?: string;
}

/** One request and its answer. */
export interface Turn {
  q: string;
  a: string;
  acts: Act[];
  error?: string;
  /** the folder Claude named for work inside a project's files */
  code?: string;
  model?: string;
  at: string;
}

export interface Chat {
  id: string;
  title: string;
  created: string;
  updated: string;
  /** the Claude Code session the next request resumes */
  session: string | null;
  turns: Turn[];
}

/** A chat as the list shows it. */
export interface ChatHead {
  id: string;
  title: string;
  updated: string;
  turns: number;
}

export const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIR = `${STATE}/chats`;
const TITLE = 60;

/** Pure: a chat's title from its first request: the first line, spaces collapsed, cut at a word. */
export function titleOf(q: string): string {
  const line = q.trim().split("\n")[0].replace(/\s+/g, " ").trim();
  if (line.length <= TITLE) return line;
  const cut = line.slice(0, TITLE);
  const word = cut.lastIndexOf(" ");
  return `${(word > TITLE / 2 ? cut.slice(0, word) : cut).replace(/[\s,.;:]+$/, "")}…`;
}

export const headOf = (c: Chat): ChatHead => ({ id: c.id, title: c.title, updated: c.updated, turns: c.turns.length });

export async function readChat(id: string, dir = DIR): Promise<Chat | null> {
  if (!CHAT_ID.test(id)) return null;
  const c = await readJson<Chat>(`${dir}/${id}.json`);
  return c && c.id === id && Array.isArray(c.turns) ? c : null;
}

/** Every chat, the last one spoken in first. */
export async function listChats(dir = DIR): Promise<ChatHead[]> {
  const out: ChatHead[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      const id = e.isFile && e.name.endsWith(".json") ? e.name.slice(0, -5) : "";
      const c = id ? await readChat(id, dir) : null;
      if (c) out.push(headOf(c));
    }
  } catch { /* no chat yet */ }
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Adds a turn to the chat `id`, made with its first request when there is none yet. */
export async function saveTurn(id: string, session: string | null, turn: Turn, dir = DIR): Promise<Chat> {
  if (!CHAT_ID.test(id)) throw new Error(`bad chat id: ${id}`);
  const c = await readChat(id, dir) ??
    { id, title: titleOf(turn.q), created: turn.at, updated: turn.at, session: null, turns: [] };
  const next: Chat = { ...c, updated: turn.at, session: session ?? c.session, turns: [...c.turns, turn] };
  await Deno.mkdir(dir, { recursive: true });
  await writeAtomic(`${dir}/${id}.json`, JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Forgets a chat here (its Claude Code session stays where Claude Code keeps it). */
export async function removeChat(id: string, dir = DIR): Promise<boolean> {
  if (!CHAT_ID.test(id)) return false;
  return await Deno.remove(`${dir}/${id}.json`).then(() => true, () => false);
}
