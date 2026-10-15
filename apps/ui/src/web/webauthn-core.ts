// webauthn-core.ts — the phone's yes (ADR 0014, G5), the part with no DOM: the challenge the contract defines,
// the encodings, and the options of a new passkey. Runs under Deno in apps/brain/tests/webapp_ui_test.ts.

import { canonical, signedText } from "../../../../shared/mcp/lib/nodes.ts";
import type { ProposedJob } from "./lib.ts";

const enc = new TextEncoder();

/** Pure: bytes as base64url, no padding. */
export function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Pure: base64url as bytes. */
export function unb64u(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(new ArrayBuffer(b.length));
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function sha256(text: string): Promise<Uint8Array<ArrayBuffer>> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return new Uint8Array(d);
}

export type Verdict = "allow" | "session" | "deny";

/** What the person says yes or no to: the fields the challenge covers. `answers` is left out when there are none. */
export interface AnswerBody {
  id: string;
  node: string;
  verdict: Verdict;
  answers?: Record<string, string>;
  expires: string;
}

/** Pure: the text a request's answer signs: `agents-multi answer v1\n` and the canonical JSON of the answer. */
export const answerText = (a: AnswerBody) =>
  `agents-multi answer v1\n${canonical({ id: a.id, node: a.node, verdict: a.verdict, answers: a.answers, expires: a.expires })}`;

/** The challenge of an answer: SHA-256 of its text. */
export const answerChallenge = (a: AnswerBody) => sha256(answerText(a));

/** The challenge of accepting a job: SHA-256 of the text the desktop signs for it (nodes.ts's signedText). */
export const jobChallenge = (j: Pick<ProposedJob, "id" | "node" | "kind" | "spec">, expires: string) =>
  sha256(signedText({ id: j.id, node: j.node, kind: j.kind, spec: j.spec, expires } as Parameters<typeof signedText>[0]));

/** Pure: when an answer stops counting: five minutes from `now` (the contract allows ten). */
export const expiryFrom = (now: Date, minutes = 5) => new Date(now.getTime() + minutes * 60_000).toISOString();

/** What the service gets with an answer. */
export interface Assertion {
  credential: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** What the service gets with an answer. */
export interface Assertion {
  credential: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** The options of `navigator.credentials.create`, with the binary fields as bytes (the DOM's own type is left to webauthn.ts). */
export interface CreationOptions {
  challenge: Uint8Array<ArrayBuffer>;
  user: { id: Uint8Array<ArrayBuffer>; name: string; displayName: string };
  excludeCredentials: { type: "public-key"; id: Uint8Array<ArrayBuffer>; transports?: string[] }[];
  [k: string]: unknown;
}

/** Pure: the options the service sends (WebAuthn's JSON form: base64url challenge and ids, maybe inside
 *  `publicKey`) as the object `navigator.credentials.create` takes. */
export function creationOptions(raw: Record<string, unknown>): CreationOptions {
  const o = ((raw.publicKey as Record<string, unknown> | undefined) ?? raw) as Record<string, unknown>;
  const user = o.user as { id: string; name: string; displayName?: string };
  const exclude = (o.excludeCredentials as { id: string; type?: string; transports?: string[] }[] | undefined) ?? [];
  return {
    ...(o as unknown as CreationOptions),
    challenge: unb64u(o.challenge as string),
    user: { ...user, displayName: user.displayName ?? user.name, id: unb64u(user.id) },
    excludeCredentials: exclude.map((c) => ({ type: "public-key" as const, id: unb64u(c.id), transports: c.transports })),
  };
}

