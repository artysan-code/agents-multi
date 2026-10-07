// api.ts — what «Hey Claude» reads and does: the console's ask endpoint (POST /api/ask, streamed as
// NDJSON: apps/cli/ask.ts), the model shared with the console's field, and the hand-over to a terminal
// (POST /api/terminal). The same endpoints as the field at the foot of Today.

import { get, ndjson, post, postInit, type Result } from "../../api.ts";

/** One line of /api/ask's answer (`Out` in apps/cli/ask.ts). */
export type AskLine =
  | { t: "session"; id: string }
  | { t: "text"; d: string }
  | { t: "tool"; k: string }
  | { t: "done"; text: string; code: string | null; error?: string };

export const heyApi = {
  model: () => get<{ models: string[]; model: string }>("/api/ask/model"),
  setModel: (model: string) => post<Result>("/api/ask/model", { model }),
  /** Asks, continuing `session` when given; `on` gets each line as it comes. Aborting `signal` stops
   *  claude -p on the server. */
  async ask(text: string, session: string | null, signal: AbortSignal, on: (l: AskLine) => void): Promise<void> {
    const res = await fetch("/api/ask", postInit({ text, kind: "ask", session }, signal));
    if (!res.ok || !res.body) {
      throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    await ndjson<AskLine>(res, on);
  },
  /** Claude Code in a terminal: resuming the conversation, or in a folder on a request. */
  terminal: (body: { resume: string } | { cwd: string; ask: string }) => post<Result>("/api/terminal", body),
  /** The part of /api/status the page reads: the machine's interface language. */
  status: () => get<{ language: string }>("/api/status"),
};
