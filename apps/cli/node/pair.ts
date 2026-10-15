// pair.ts — pairing this machine with a code (ADR 0014, G4): `agents node pair` and the console's «Pair with a code».
// The machine asks the service for a pairing (no credential), shows the short code, and polls with the secret only it
// holds until the person has typed the code in the web app's Machines page; the answer carries the node's own token,
// once. Nothing here listens: it is outbound HTTPS, as every node call is.

import { ANSI } from "../lib/output.ts";

/** What the service answers a new pairing with. */
export interface Pairing {
  code: string;
  pairing: string;
  expires: string;
}

type Polled = { state: "waiting" } | { state: "expired" } | { state: "done"; token: string; url?: string };

export interface PairIO {
  fetcher?: typeof fetch;
  /** the code is up: show it */
  show: (p: { code: string; url: string; expires: string }) => void;
  /** a tick while it waits (a spinner) */
  tick?: (waitedMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  /** how often the service is asked */
  everyMs?: number;
}

export type PairResult = { ok: true; token: string } | { ok: false; message: string };

/** Pure: where the person types the code: the web app's Machines page. */
export const machinesUrl = (base: string): string => `${base.replace(/\/+$/, "")}/app#/machines`;

/** Pure: the code spaced out for reading from across a desk: `A B C D - 2 3 4 5`, bold. */
export function bigCode(code: string): string {
  return `${ANSI.b}${[...code].join(" ")}${ANSI.x}`;
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Pure: one frame of the waiting spinner. */
export const spinnerFrame = (waitedMs: number, every = 120): string =>
  SPINNER[Math.floor(waitedMs / every) % SPINNER.length];

const failure = async (r: Response, what: string): Promise<string> => {
  const e = await r.json().catch(() => ({})) as { error?: string };
  return `${what}: ${e.error ?? `HTTP ${r.status}`}`;
};

/** Asks the service for a pairing and waits for the person to claim it: the token, or why not (the code expired, the
 *  service said no, the wait was cancelled). A poll that fails on the network is tried again until the code expires. */
export async function pairMachine(
  base: string,
  name: string,
  platform: string,
  io: PairIO,
): Promise<PairResult> {
  const fetcher = io.fetcher ?? fetch;
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const root = base.replace(/\/+$/, "");
  let p: Pairing;
  try {
    const r = await fetcher(`${root}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, platform }),
      signal: io.signal ? AbortSignal.any([io.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { ok: false, message: await failure(r, `${root} would not start a pairing`) };
    p = await r.json() as Pairing;
    if (typeof p.code !== "string" || typeof p.pairing !== "string") throw new Error("not a pairing");
  } catch (e) {
    return { ok: false, message: `could not reach ${root}: ${(e as Error).message}` };
  }
  io.show({ code: p.code, url: machinesUrl(root), expires: p.expires });
  const began = now();
  // a little past the code's life, so the service has the last word on whether it expired
  const until = (Date.parse(p.expires) || began + 10 * 60_000) + 15_000;
  const every = io.everyMs ?? 2_000;
  while (!io.signal?.aborted && now() < until) {
    await sleep(every);
    io.tick?.(now() - began);
    try {
      const r = await fetcher(`${root}/api/pair/${encodeURIComponent(p.pairing)}`, {
        signal: io.signal ? AbortSignal.any([io.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        // too many requests (429) or a service hiccup: wait and ask again; anything else will not get better
        if (r.status === 429 || r.status >= 500) {
          await r.body?.cancel();
          continue;
        }
        return { ok: false, message: await failure(r, "the service refused the pairing") };
      }
      const d = await r.json() as Polled;
      if (d.state === "done" && typeof d.token === "string" && d.token) return { ok: true, token: d.token };
      if (d.state === "expired") return { ok: false, message: "the code expired before it was typed: run it again" };
    } catch { /* a network error: ask again until the code expires */ }
  }
  return {
    ok: false,
    message: io.signal?.aborted ? "cancelled" : "the code expired before it was typed: run it again",
  };
}
