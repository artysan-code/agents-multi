// codex-driver.ts — a Codex child's process, which the hub starts detached like Claude's. `codex exec`
// runs one turn and ends, so the driver is what makes it a session: it reads the child's `in` (the
// same user lines Claude's stdin takes), runs a turn for each — the first as `exec`, the next as `exec
// resume <thread>` — and writes what happens to `out.jsonl` in Claude's stream-json (`codexLines`), so
// the hub follows it with the code it has. It ends when `in` closes, after the turn it is in.
//
//   deno run codex-driver.ts <run folder>     env: CODEX_BIN, CODEX_HOME, CODEX_SANDBOX, CODEX_MODEL?, CODEX_CONFIG? (JSON: `-c` overrides)

import { codexArgs, codexLines, type Turn } from "../lib/codex.ts";

const run = Deno.args[0];
const env = (k: string) => Deno.env.get(k) ?? "";
const out = await Deno.open(`${run}/out.jsonl`, { create: true, append: true });
const enc = new TextEncoder();
const put = (o: Record<string, unknown>) => out.write(enc.encode(JSON.stringify(o) + "\n"));

// extra `-c key=value` overrides of the child's MCP servers (providers.ts), as a JSON array in the environment
const config: string[] = JSON.parse(env("CODEX_CONFIG") || "[]");
let thread: string | undefined;

/** One turn; resolves when `codex exec` has ended, with its events already in `out.jsonl`. */
async function turn(prompt: string) {
  await put({ type: "user", message: { role: "user", content: prompt } });
  const t: Turn = { last: "" };
  let closed = false;
  const p = new Deno.Command(env("CODEX_BIN"), {
    args: codexArgs({ thread, sandbox: env("CODEX_SANDBOX"), model: env("CODEX_MODEL") || undefined, prompt, config }),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // stderr is the log (`err.log`); the events are stdout's lines
  const log = await Deno.open(`${run}/err.log`, { create: true, append: true });
  const logging = p.stderr.pipeTo(log.writable);
  let buf = "";
  for await (const chunk of p.stdout.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "thread.started" && typeof e.thread_id === "string") thread = e.thread_id;
      if (e.type === "turn.completed" || e.type === "turn.failed") closed = true;
      for (const l of codexLines(e, t)) await put(l);
    }
  }
  await logging;
  const status = await p.status;
  // an exit with no verdict (a crash, a login that is gone) is still the end of the turn
  if (!closed) {
    await put({ type: "result", subtype: "error", is_error: true, result: `codex exited with code ${status.code}` });
  }
}

/** The text of a user line on `in`; null for anything else (Claude's control lines have no meaning here). */
function userText(line: string): string | null {
  try {
    const e = JSON.parse(line);
    return e?.type === "user" && typeof e.message?.content === "string" ? e.message.content : null;
  } catch {
    return null;
  }
}

const input = await Deno.open(`${run}/in`, { read: true });
let buf = "";
for await (const chunk of input.readable.pipeThrough(new TextDecoderStream())) {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const text = userText(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (text) await turn(text);
  }
}
