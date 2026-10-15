// api.ts — what «Hey Claude» reads and does: the console's ask endpoint (POST /api/ask, streamed as
// NDJSON: apps/cli/ask.ts) and the hand-over to a terminal (POST /api/terminal). The same endpoints as
// the console's Chat page, where a conversation started here shows too; the model, shared with it, is
// lib/model-picker.tsx's.

import { api, askStream, get } from "../../api.ts";

export const heyApi = {
  /** Asks, continuing the chat `chat` when given; `on` gets each line as it comes. */
  ask: askStream,
  /** Claude Code in a terminal: resuming the conversation, or in a folder on a request. */
  terminal: (body: { resume: string } | { cwd: string; ask: string }) => api.terminal(body),
  /** The part of /api/status the page reads: the machine's interface language. */
  status: () => get<{ language: string }>("/api/status"),
};
