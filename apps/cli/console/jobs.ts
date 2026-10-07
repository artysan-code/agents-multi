// jobs.ts — long actions with their output streamed: POST /api/job starts one (the same allowlist and
// parameter checks as /api/action), GET /api/job?id= streams its output as it is written, one JSON per
// line (`{"o": text}`, then `{"done": code, "ms": n}`), and POST /api/job/cancel stops it. A job is
// kept in memory after it ends (the last few), so a page that opens late still gets its whole output.
// One job at a time per action: asking again while it runs answers with the one already running.

import { REPO } from "../lib/paths.ts";
import { ACTIONS, afterAction, type Params, resolveAction, type Resolved, stripColours } from "./actions.ts";

interface Job {
  id: string;
  action: string;
  chunks: string[];
  done: { code: number; ms: number; cancelled: boolean } | null;
  child: Deno.ChildProcess;
  cancelled: boolean;
  /** Woken on every new chunk and at the end. */
  wake: Set<() => void>;
}

const KEPT = 20;
const jobs = new Map<string, Job>();

/** Starts a resolved command as a job; `onDone` runs once it has ended (the page's state moved). */
export function spawnJob(
  action: string,
  r: Extract<Resolved, { cmd: string }>,
  timeoutMs: number,
  params: Params,
  onDone: () => void,
): { id: string; running: boolean } {
  const running = [...jobs.values()].find((j) => j.action === action && !j.done);
  if (running) return { id: running.id, running: true };
  const t0 = Date.now();
  const child = new Deno.Command(r.cmd, {
    args: r.args,
    cwd: REPO,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).spawn();
  const job: Job = {
    id: crypto.randomUUID(),
    action,
    chunks: [],
    done: null,
    child,
    cancelled: false,
    wake: new Set(),
  };
  jobs.set(job.id, job);
  for (const id of [...jobs.keys()].slice(0, -KEPT)) if (jobs.get(id)?.done) jobs.delete(id);
  const notify = () => {
    for (const w of job.wake) w();
  };
  const timer = setTimeout(() => stop(job), timeoutMs);
  const dec = new TextDecoder();
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const b of s) {
      job.chunks.push(stripColours(dec.decode(b, { stream: true })));
      notify();
    }
  };
  void Promise.all([pump(child.stdout), pump(child.stderr), child.status]).then(async ([, , st]) => {
    clearTimeout(timer);
    // update --check exits 10 when an update exists: not an error
    const code = action === "update-check" && st.code === 10 ? 0 : st.code;
    await afterAction(action, params, code);
    job.done = { code, ms: Date.now() - t0, cancelled: job.cancelled };
    notify();
    onDone();
  });
  return { id: job.id, running: false };
}

function stop(job: Job) {
  try {
    job.child.kill("SIGTERM");
  } catch { /* already gone */ }
}

/** Starts an allowed action as a job; a refused one (unknown action, parameter out of its allowlist) runs nothing. */
export async function startJob(
  name: string,
  opts: string[],
  params: Params,
  onDone: () => void,
): Promise<{ ok: true; id: string; running: boolean } | { ok: false; message: string }> {
  const r = await resolveAction(name, opts, params);
  if ("error" in r) return { ok: false, message: r.error };
  return { ok: true, ...spawnJob(name, r, ACTIONS[name].timeoutMs ?? 60000, params, onDone) };
}

/** SIGTERM to a running job; false when there is none by that id. */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.done) return false;
  job.cancelled = true;
  stop(job);
  return true;
}

/** The job's output from the start, then what follows, until it ends; null for an unknown id. */
export function jobStream(id: string): Response | null {
  const job = jobs.get(id);
  if (!job) return null;
  const enc = new TextEncoder();
  let wake: (() => void) | null = null;
  let gone = false;
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      const send = (o: unknown) => c.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      for (let i = 0; !gone;) {
        for (; i < job.chunks.length; i++) send({ o: job.chunks[i] });
        if (job.done) {
          send({ done: job.done.code, ms: job.done.ms, cancelled: job.done.cancelled });
          return c.close();
        }
        await new Promise<void>((res) => {
          wake = res;
          job.wake.add(res);
        });
        job.wake.delete(wake!);
      }
    },
    cancel() {
      gone = true;
      if (wake) {
        job.wake.delete(wake);
        wake();
      }
    },
  });
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
