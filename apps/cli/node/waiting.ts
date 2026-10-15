// waiting.ts — what waits on this machine, relayed to the phone, and the phone's yes, checked here (ADR 0014,
// G5). The hub's pending requests and questions go to the service when they change and with each announce;
// the answers the phone sent come back and are believed only after the node itself verified them: the
// passkey's endorsement with the owner's approval key, then the WebAuthn assertion, expiry and replay
// (shared/mcp/lib/webauthn.ts). Only then does the hub get its answer; a refusal is reported back with why.
// The service decides nothing: a stolen session or a broken service gets a "refused" and no agent moves.

import { answer as hubAnswer, type Child, listChildren, runsDir } from "../../../shared/mcp/lib/agents.ts";
import type { NodeConfig } from "../../../shared/mcp/lib/headless.ts";
import {
  answerKey,
  type Passkey,
  type PasskeyCtx,
  type PhoneAnswer,
  siteOf,
  type Verdict,
  verifyAnswer,
} from "../../../shared/mcp/lib/webauthn.ts";
import { approvalKey, nodeName } from "./facts.ts";
import type { Service } from "./service.ts";

/** What the service is told about a pending request (ADR 0014): `id` is `<child>/<request>`. */
export interface Relayed {
  id: string;
  child: string;
  request: string;
  profile: string;
  project: string;
  kind: "request" | "question";
  what: string;
  questions?: unknown[];
}

/** Pure: the requests and questions the children of this machine wait on, as the service is told. */
export function requestsOf(children: Child[]): Relayed[] {
  return children.filter((c) => c.state.phase !== "ended").flatMap((c) =>
    c.state.pending.map((p): Relayed => ({
      id: `${c.meta.id}/${p.request}`,
      child: c.meta.id,
      request: p.request,
      profile: c.meta.profile,
      project: c.meta.project ?? c.meta.dir,
      kind: p.kind,
      what: p.what,
      ...(p.questions ? { questions: p.questions } : {}),
    }))
  );
}

/** Pure: the child and the request an id names, or null. */
export function splitId(id: string): { child: string; request: string } | null {
  const i = id.indexOf("/");
  return i > 0 && i < id.length - 1 ? { child: id.slice(0, i), request: id.slice(i + 1) } : null;
}

// ---------------------------------------------------------------- the service's side of it

export const putRequests = (s: Service, requests: Relayed[]) =>
  s.call<{ ok: boolean }>("PUT", "/api/node/requests", { requests });
export const getAnswers = async (s: Service) =>
  (await s.call<{ answers: PhoneAnswer[] }>("GET", "/api/node/answers")).answers ?? [];
export const reportAnswers = (s: Service, results: AnswerResult[]) =>
  s.call<{ ok: boolean }>("POST", "/api/node/answers", { results });
/** Every passkey of the account, endorsed or not: the node decides which count. */
export const getPasskeys = async (s: Service): Promise<Passkey[]> => {
  const r = await s.call<Passkey[] | { passkeys: Passkey[] }>("GET", "/api/passkeys");
  return Array.isArray(r) ? r : r.passkeys ?? [];
};

// ---------------------------------------------------------------- relaying what waits

let lastSent = "";

/** Tells the service what waits on this machine: when it changed since the last time, or `force`d (each announce
 *  does, so a service that lost it learns it again). Returns how many wait. */
export async function relayRequests(svc: Service, force = false): Promise<number> {
  const reqs = requestsOf(await listChildren());
  const json = JSON.stringify(reqs);
  if (force || json !== lastSent) {
    await putRequests(svc, reqs);
    lastSent = json;
  }
  return reqs.length;
}

// ---------------------------------------------------------------- believing the phone

export interface AnswerResult {
  id: string;
  ok: boolean;
  why?: string;
}

/** What this node did with the answers that verified: the key of each (its challenge) and how it ended, "" for
 *  applied or what the hub said. An answer comes back from the service until it is reported, so a repeat is told
 *  again what happened, never done twice. One that did not verify is not kept: it is refused again the same way. */
export interface AnswerState {
  done: Record<string, string>;
}

export const answerStateFile = (runs = runsDir()) => `${runs}/node/answers.json`;

export async function readAnswerState(file = answerStateFile()): Promise<AnswerState> {
  const s = await Deno.readTextFile(file).then(JSON.parse).catch(() => null) as Partial<AnswerState> | null;
  return { done: s?.done && typeof s.done === "object" ? s.done : {} };
}

async function writeAnswerState(st: AnswerState, file = answerStateFile()) {
  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  const keep = Object.fromEntries(Object.entries(st.done).slice(-500));
  const tmp = `${file}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify({ done: keep }, null, 2) + "\n");
  await Deno.rename(tmp, file);
}

export interface AnswerDeps {
  /** this node's name, the service's address as origin and host, and the owner's approval key */
  self: string;
  url: string;
  ownerKey: string | null;
  now: () => number;
  /** the account's passkeys, read once and only when an answer needs them */
  passkeys: () => Promise<Passkey[]>;
  /** the hub's answer; throws when the child is not waiting on that request */
  answer: (child: string, request: string, verdict: Verdict, answers?: Record<string, string>) => Promise<void>;
}

/** Verifies each answer exactly as the contract says and applies the ones that hold; returns what to report.
 *  An answer whose passkeys could not be read is left out (it comes again, the failure being ours). */
export async function applyAnswers(list: PhoneAnswer[], st: AnswerState, d: AnswerDeps): Promise<AnswerResult[]> {
  const out: AnswerResult[] = [];
  let ctx: PasskeyCtx | null = null;
  for (const a of list) {
    if (!a || typeof a.id !== "string") continue;
    const key = await answerKey(a).catch(() => null);
    if (!key) {
      out.push({ id: a.id, ok: false, why: "not an answer" });
      continue;
    }
    if (key in st.done) {
      out.push(st.done[key] === "" ? { id: a.id, ok: true } : { id: a.id, ok: false, why: st.done[key] });
      continue;
    }
    if (!ctx) {
      try {
        ctx = { site: siteOf(d.url), passkeys: await d.passkeys(), ownerKey: d.ownerKey, now: d.now() };
      } catch {
        continue;
      }
    }
    const refused = await verifyAnswer(a, d.self, { ...ctx, now: d.now() }, []);
    if (refused) {
      // not remembered: a copy of an answer with a wrong signature must not use up the genuine one's key
      out.push({ id: a.id, ok: false, why: refused });
      continue;
    }
    let why: string | null = null;
    const target = splitId(a.id);
    try {
      if (!target) throw new Error("not a request id");
      await d.answer(target.child, target.request, a.verdict, a.answers);
    } catch (e) {
      why = (e as Error).message;
    }
    st.done[key] = why ?? "";
    out.push(why ? { id: a.id, ok: false, why } : { id: a.id, ok: true });
  }
  return out;
}

let handling: Promise<unknown> = Promise.resolve();

/** Applies the phone's answers on this machine, one batch at a time (the announce and the quick poll both come
 *  here), reports each to the service and tells the owner of a refusal. */
export function handleAnswers(
  cfg: NodeConfig,
  svc: Service,
  list: PhoneAnswer[],
  o: { log: (s: string) => void; notify: (title: string, body: string) => void },
): Promise<void> {
  const run = async () => {
    if (!list.length) return;
    const self = nodeName(cfg);
    const st = await readAnswerState();
    const results = await applyAnswers(list, st, {
      self,
      url: svc.url,
      ownerKey: await approvalKey(cfg),
      now: Date.now,
      passkeys: () => getPasskeys(svc),
      answer: (child, request, verdict, answers) => hubAnswer(child, request, verdict, undefined, runsDir(), answers),
    });
    await writeAnswerState(st);
    for (const r of results) {
      if (r.ok) o.log(`node: the phone answered ${r.id}`);
      else {
        o.log(`node: the phone's answer to ${r.id} refused: ${r.why}`);
        o.notify(`An answer from the phone was refused on ${self}`, `${r.id}: ${r.why}`);
      }
    }
    if (results.length) await reportAnswers(svc, results);
  };
  const next = handling.then(run, run);
  handling = next.catch(() => {});
  return next;
}
