// turns.ts — this machine answering the chat of the service (ADR 0014, G1). The phone writes a turn in the
// service; a node that is on holds one long poll open to it (`GET /api/node/turns`, outbound, its own node token),
// runs each turn it is given with the console's own runner (ask.ts: `claude -p`, resumed, the fixed tool list) and
// posts the answer back in pieces (`/api/turns/<id>/events`, at most every 300 ms) and at the end (`…/done`).
// One turn at a time. On a headless node the child gets what every headless child gets (ADR 0013): the sandbox
// settings and the account's token from the vault, with Claude Code's scrub on (shared/mcp/lib/headless.ts).

import { claudeSessionVars } from "../../../shared/mcp/lib/agents.ts";
import { childEnv, childSettings, loadNodeConfig, type NodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { configDir } from "../../../shared/mcp/lib/owner.ts";
import { type Earlier, type Out, runTurn, type TurnOpts } from "../ask.ts";
import { HOME, RUNTIME } from "../lib/paths.ts";
import { type Service, service } from "./service.ts";

/** A turn the service gave this node (the contract of ADR 0014). */
export interface Claimed {
  id: string;
  chat: string;
  text: string;
  session: string | null;
  history: Earlier[];
}

/** What goes back to the service while a turn runs. */
export type Piece = Exclude<Out, { t: "chat" } | { t: "done" }>;
type Done = Extract<Out, { t: "done" }>;

/** Runs one answer: ask.ts's runTurn, or a stand-in in tests. */
export type Runner = (text: string, o: TurnOpts, onEvent: (o: Out) => void) => Promise<Done>;

export const WAIT_S = 25;
export const BATCH_MS = 300;
const BACKOFF = { min: 2_000, max: 60_000 };

/** Pure: consecutive text pieces become one (a streamed answer is hundreds of small deltas). */
export function coalesce(events: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (e.t === "text" && last?.t === "text") out[out.length - 1] = { t: "text", d: last.d + e.d };
    else out.push(e);
  }
  return out;
}

/** What is sent as events accumulate: one flush at a time, at most one every `ms`, and at the end what is left.
 *  A flush that fails keeps its events for the next one (the service may come back); `close()` gives up. */
export function batcher(flush: (events: Piece[]) => Promise<void>, ms = BATCH_MS) {
  let pending: Piece[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> = Promise.resolve();
  const send = () => {
    timer = undefined;
    inflight = inflight.then(async () => {
      if (!pending.length) return;
      const batch = coalesce(pending);
      pending = [];
      try {
        await flush(batch);
      } catch {
        pending = [...batch, ...pending];
      }
    });
    return inflight;
  };
  return {
    push(e: Piece) {
      pending.push(e);
      timer ??= setTimeout(send, ms);
    },
    async close() {
      if (timer !== undefined) clearTimeout(timer);
      await send();
    },
  };
}

/** Pure: the environment of a headless turn's child: the machine's own, without a Claude session's variables and
 *  without the keys that outrank the account's token; `AM_HEADLESS` / `AM_CLAUDE_TOKEN` (headless.ts childEnv)
 *  become Claude Code's scrub and token variables, as the hub's start script does for its children. */
export function headlessTurnEnv(base: Record<string, string>, held: Record<string, string>): Record<string, string> {
  const env = { ...base };
  for (const n of claudeSessionVars(Object.keys(env))) delete env[n];
  delete env.AM_HEADLESS;
  delete env.AM_CLAUDE_TOKEN;
  if (!held.AM_HEADLESS) return env;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  if (held.AM_CLAUDE_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = held.AM_CLAUDE_TOKEN;
  return env;
}

/** On a headless node: the sandbox's settings and the scrubbed environment with the token; on a desktop, none. */
export async function headlessPrepare(profile: string) {
  const held = await childEnv(profile, "claude");
  if (!held.AM_HEADLESS) return {};
  return {
    env: headlessTurnEnv(Deno.env.toObject(), held),
    settings: await childSettings(HOME, RUNTIME, configDir()),
  };
}

const realRunner: Runner = (text, o, onEvent) => runTurn(text, { ...o, prepare: headlessPrepare }, onEvent);

export interface LoopIO {
  log: (s: string) => void;
  signal: AbortSignal;
  /** the node's settings, read every pass (`agents node enable` takes effect without a restart) */
  config?: () => Promise<NodeConfig>;
  /** the service as this node, or why not */
  service?: () => Promise<Service | string>;
  run?: Runner;
  /** waits ms, or less when the loop stops */
  sleep?: (ms: number) => Promise<void>;
  batchMs?: number;
  /** how long an idle pass waits when the node is off or the service cannot be reached the first time */
  idleMs?: number;
}

const sleepFor = (signal: AbortSignal) => (ms: number) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
  });

/** How often a running turn says it is alive when it has nothing to send: the service hands a turn silent for
 *  90 s back to `waiting` (ADR 0014), and a Claude step can be silent longer than that. */
export const HEARTBEAT_MS = 30_000;

/** Answers one turn: the pieces go to the service as they come, an empty batch every 30 s keeps it ours, then the
 *  end (`error` when it failed, with what had been said so far). */
export async function answerTurn(
  svc: Service,
  t: Claimed,
  run: Runner,
  signal: AbortSignal,
  batchMs = BATCH_MS,
  heartbeatMs = HEARTBEAT_MS,
): Promise<{ error?: string }> {
  const post = async (events: Piece[]) => {
    await svc.call("POST", `/api/turns/${t.id}/events`, { events }, { signal });
  };
  const out = batcher(post, batchMs);
  const beat = setInterval(() => post([]).catch(() => {}), heartbeatMs);
  let said = "";
  let done: Done;
  try {
    done = await run(t.text, { session: t.session, history: t.history, signal }, (o) => {
      if (o.t === "text") said += o.d;
      if (o.t === "session" || o.t === "text" || o.t === "tool") out.push(o);
    });
  } catch (e) {
    done = { t: "done", text: said, code: null, error: (e as Error).message };
  } finally {
    clearInterval(beat);
  }
  await out.close();
  const body = {
    text: done.text,
    ...(done.code ? { code: done.code } : {}),
    ...(done.error ? { error: done.error } : {}),
  };
  let last: Error | undefined;
  for (let i = 0; i < 3 && !signal.aborted; i++) {
    try {
      await svc.call("POST", `/api/turns/${t.id}/done`, body, { signal });
      return done.error ? { error: done.error } : {};
    } catch (e) {
      last = e as Error;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last ?? new Error("stopped before the turn could be reported");
}

/** The loop: poll, answer, poll again; backs off while the service is down; returns when `signal` aborts. */
export async function turnLoop(io: LoopIO): Promise<void> {
  const { signal, log } = io;
  const config = io.config ?? (() => loadNodeConfig());
  const getService = io.service ?? (() => service(fetch, { node: true }));
  const run = io.run ?? realRunner;
  const sleep = io.sleep ?? sleepFor(signal);
  const idle = io.idleMs ?? 30_000;
  let wait = BACKOFF.min, said = "";
  const say = (m: string) => {
    if (m !== said) log(`node: ${m}`);
    said = m;
  };
  while (!signal.aborted) {
    try {
      if (!(await config()).enabled) {
        await sleep(idle);
        continue;
      }
      const svc = await getService();
      if (typeof svc === "string") {
        say(svc);
        await sleep(idle);
        continue;
      }
      const began = Date.now();
      // one turn at a time: a turn claimed and left waiting here would look silent and be handed to another node
      const { turns } = await svc.call<{ turns?: Claimed[] }>(
        "GET",
        `/api/node/turns?wait=${WAIT_S}&max=1`,
        undefined,
        {
          timeout: (WAIT_S + 15) * 1000,
          signal,
        },
      );
      said = "";
      wait = BACKOFF.min;
      // a service that answers at once with nothing is not a long poll: never a busy loop
      if (!turns?.length && Date.now() - began < 1000) await sleep(1000);
      for (const t of turns ?? []) {
        if (signal.aborted) break;
        const r = await answerTurn(svc, t, run, signal, io.batchMs);
        if (r.error) log(`node: chat turn ${t.id} failed: ${r.error}`);
      }
    } catch (e) {
      if (signal.aborted) break;
      say((e as Error).message);
      await sleep(wait);
      wait = Math.min(wait * 2, BACKOFF.max);
    }
  }
}

/** Starts the loop in the console's backend (agentd); returns what stops it. */
export function startTurns(log: (s: string) => void): () => void {
  const stop = new AbortController();
  void turnLoop({ log, signal: stop.signal });
  return () => stop.abort();
}
