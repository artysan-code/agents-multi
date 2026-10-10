// api.ts — what «Hey Claude» reads and does: the console's ask endpoint (POST /api/ask, streamed as
// NDJSON: apps/cli/ask.ts) and the hand-over to a terminal (POST /api/terminal). The same endpoints as
// the console's ask bar; the model, shared with it, is lib/model-picker.tsx's.

import { api, type AskLine, get, ndjson } from "../../api.ts";

export const heyApi = {
  /** Asks, continuing `session` when given; `on` gets each line as it comes. Aborting `signal` stops
   *  claude -p on the server. */
  async ask(text: string, session: string | null, signal: AbortSignal, on: (l: AskLine) => void): Promise<void> {
    const res = await api.ask({ text, kind: "ask", session }, signal);
    if (!res.ok || !res.body) {
      throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    await ndjson<AskLine>(res, on);
  },
  /** Claude Code in a terminal: resuming the conversation, or in a folder on a request. */
  terminal: (body: { resume: string } | { cwd: string; ask: string }) => api.terminal(body),
  /** The part of /api/status the page reads: the machine's interface language. */
  status: () => get<{ language: string }>("/api/status"),
};
