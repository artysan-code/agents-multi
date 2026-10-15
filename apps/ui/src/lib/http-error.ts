// http-error.ts — what a refused request says, for a person: the console answers a refusal with JSON
// (`{ok:false,message}` or `{error}`), and the page used to show that JSON as it came, status included.

/** The message of a failed response's body: its `message` or `error`, else the text, else the status. */
export function errorText(status: number, body: string): string {
  const text = body.trim();
  try {
    const j = JSON.parse(text) as { message?: unknown; error?: unknown };
    const m = j && typeof j === "object" ? j.message ?? j.error : null;
    if (typeof m === "string" && m) return m;
  } catch { /* not JSON: the text is the message */ }
  return text || `HTTP ${status}`;
}
