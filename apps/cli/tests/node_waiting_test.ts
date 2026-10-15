// node_waiting_test.ts — what waits on this machine and the phone's yes, as the node handles it
// (apps/cli/node/waiting.ts, apps/cli/passkeys.ts): the requests it relays, each answer verified before the hub is
// touched, a refusal reported with why, an answer never applied twice, and the passkeys the owner endorses.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { type AnswerDeps, type AnswerState, applyAnswers, requestsOf, splitId, wordsOf } from "../node/waiting.ts";
import { findPasskey, passkeyLines, revokeTarget, rowsOf, stateOf } from "../passkeys.ts";
import { approvalKeys } from "../../../shared/mcp/lib/nodes.ts";
import {
  type AnswerBody,
  answerChallenge,
  boundWords,
  fingerprint,
  type Passkey,
  type PhoneAnswer,
  signEndorsement,
  wordsHash,
} from "../../../shared/mcp/lib/webauthn.ts";
import type { Child } from "../../../shared/mcp/lib/agents.ts";
import { Authenticator, SITE } from "./fixtures/authenticator.ts";

const NOW = Date.parse("2026-10-15T20:00:00Z");

const child = (id: string, phase: string, pending: unknown[], extra: Record<string, unknown> = {}) =>
  ({
    meta: { id, profile: "work", dir: "/home/a/proj/sub", project: "/home/a/proj", ...extra },
    state: { phase, pending },
  }) as unknown as Child;

Deno.test("node waiting: the pending requests of live children, as the service is told", () => {
  const out = requestsOf([
    child("c-aaa", "waiting", [
      { request: "r1", kind: "request", what: "Bash: git push", input: {}, session: "x", at: 1 },
      { request: "r2", kind: "question", what: "Which?", questions: [{ question: "Which?", options: [] }], at: 2 },
    ]),
    child("c-bbb", "ended", [{ request: "r9", kind: "request", what: "gone", at: 1 }]),
    child("c-ccc", "working", []),
    child("c-ddd", "waiting", [{ request: "r3", kind: "request", what: "Edit a", at: 3 }], { project: undefined }),
  ]);
  assertEquals(out.map((r) => r.id), ["c-aaa/r1", "c-aaa/r2", "c-ddd/r3"]);
  assertEquals(out[0], {
    id: "c-aaa/r1",
    child: "c-aaa",
    request: "r1",
    profile: "work",
    project: "/home/a/proj",
    kind: "request",
    what: "Bash: git push",
  });
  assertEquals(out[1].questions?.length, 1);
  assertEquals(out[1].questions, [{ question: "Which?", options: [] }], "relayed in the bounded form the phone hashes");
  assertEquals(out[2].project, "/home/a/proj/sub", "a child with no project says its folder");
});

Deno.test("node waiting: an id is its child and its request", () => {
  assertEquals(splitId("c-aaa/r1"), { child: "c-aaa", request: "r1" });
  assertEquals(splitId("c-aaa/a/b"), { child: "c-aaa", request: "a/b" });
  for (const bad of ["", "c-aaa", "/r1", "c-aaa/"]) assertEquals(splitId(bad), null);
});

Deno.test("node waiting: the words are bounded before they go, and hashed from the hub's own copy", async () => {
  const long = "w".repeat(3000);
  const children = [child("c-aaa", "waiting", [{ request: "r1", kind: "request", what: long, at: 1 }])];
  const [r] = requestsOf(children);
  assertEquals(r.what.length, 1000);
  // the hash is the one of what the phone is shown (the relayed form), never of what a service sends back
  assertEquals(await wordsOf(children, "c-aaa", "r1"), await wordsHash({ what: r.what, questions: r.questions }));
  assertEquals(await wordsOf(children, "c-aaa", "r9"), null);
  assertEquals(await wordsOf(children, "c-zzz", "r1"), null);
  assertEquals(
    await wordsOf([child("c-aaa", "ended", [{ request: "r1", kind: "request", what: "x", at: 1 }])], "c-aaa", "r1"),
    null,
  );
});

// ---- applying the phone's answers

async function world() {
  const owner = await approvalKeys(crypto.getRandomValues(new Uint8Array(32)));
  const phone = await Authenticator.make();
  const passkey: Passkey = {
    id: phone.id,
    name: "Pixel",
    publicKey: phone.publicKey,
    endorsement: await signEndorsement(phone.id, phone.publicKey, owner.sign),
    created: new Date(NOW - 1000).toISOString(),
  };
  const hub: unknown[][] = [];
  let hubFails: string | null = null, listing: Passkey[] | Error = [passkey], reads = 0;
  // what this node's hub waits on: c-aaa/r1 a request, c-aaa/r2 a question
  const hubWords: Record<string, string> = {
    "c-aaa/r1": await wordsHash(boundWords("Bash: git push")),
    "c-aaa/r2": await wordsHash(boundWords("Which?", [{ question: "Which?", options: [{ label: "A" }] }])),
  };
  const deps: AnswerDeps = {
    self: "srv",
    url: SITE.origin,
    ownerKey: owner.public,
    now: () => NOW,
    revoked: () => Promise.resolve(new Set<string>()),
    words: (c, r) => Promise.resolve(hubWords[`${c}/${r}`] ?? null),
    passkeys: () => {
      reads++;
      return listing instanceof Error ? Promise.reject(listing) : Promise.resolve(listing);
    },
    answer: (c, r, v, a) => {
      if (hubFails) return Promise.reject(new Error(hubFails));
      hub.push([c, r, v, a]);
      return Promise.resolve();
    },
  };
  const body = (x: Partial<AnswerBody> = {}): AnswerBody => {
    const id = x.id ?? "c-aaa/r1";
    return {
      id,
      node: "srv",
      verdict: "allow",
      expires: new Date(NOW + 5 * 60_000).toISOString(),
      what: hubWords[id] ?? "",
      ...x,
    };
  };
  const signed = async (b = body(), by = phone): Promise<PhoneAnswer> => {
    const { what: _what, ...rest } = b; // the service passes a node no `what`
    return { ...rest, assertion: await by.assert(await answerChallenge(b)) };
  };
  return {
    owner,
    phone,
    passkey,
    hub,
    hubWords,
    deps,
    body,
    signed,
    st: (): AnswerState => ({ done: {} }),
    reads: () => reads,
    setHubFails: (m: string | null) => (hubFails = m),
    setListing: (l: Passkey[] | Error) => (listing = l),
  };
}

Deno.test("node waiting: a verified answer reaches the hub once; asked again, it is told the same without a second try", async () => {
  const w = await world(), st = w.st();
  const a = await w.signed(w.body({ verdict: "session" }));
  assertEquals(await applyAnswers([a], st, w.deps), [{ id: "c-aaa/r1", ok: true }]);
  assertEquals(w.hub, [["c-aaa", "r1", "session", undefined]]);
  assertEquals(await applyAnswers([a], st, w.deps), [{ id: "c-aaa/r1", ok: true }]);
  assertEquals(w.hub.length, 1, "never applied twice");
  const q = await w.signed(w.body({ id: "c-aaa/r2", answers: { "Which?": "A" } }));
  await applyAnswers([q], st, w.deps);
  assertEquals(w.hub[1], ["c-aaa", "r2", "allow", { "Which?": "A" }]);
  assertEquals(w.reads(), 2, "the passkeys are read once per batch that needs them");
});

Deno.test("node waiting: a deny is verified like a yes", async () => {
  const w = await world(), st = w.st();
  const thief = await Authenticator.make();
  const forged = await w.signed(w.body({ verdict: "deny" }), thief);
  forged.assertion.credential = w.phone.id;
  const [r] = await applyAnswers([forged], st, w.deps);
  assertMatch(r.why!, /signature is not the passkey's/);
  assertEquals(w.hub, [], "an unsigned deny does not stop the agent either");
  assertEquals((await applyAnswers([await w.signed(w.body({ verdict: "deny" }))], st, w.deps))[0].ok, true);
  assertEquals(w.hub[0][2], "deny");
});

Deno.test("node waiting: each refusal is reported with why and touches nothing", async () => {
  const w = await world();
  const run = async (a: PhoneAnswer, d: Partial<AnswerDeps> = {}) => {
    const [r] = await applyAnswers([a], w.st(), { ...w.deps, ...d });
    return r;
  };
  assertEquals((await run(await w.signed(w.body({ node: "desk" })))).why, "it is for desk, not srv");
  assertEquals(
    (await run(await w.signed(w.body({ expires: new Date(NOW - 1).toISOString() })))).why,
    "its approval expired",
  );
  const unendorsed: Passkey = { ...w.passkey, endorsement: null };
  assertEquals(
    (await run(await w.signed(), { passkeys: () => Promise.resolve([unendorsed]) })).why,
    "the passkey has not been endorsed on a desktop",
  );
  assertEquals(
    (await run(await w.signed(), { passkeys: () => Promise.resolve([]) })).why,
    "not a passkey of this account",
  );
  assertMatch((await run(await w.signed(), { ownerKey: null })).why!, /no approval key/);
  // the owner's key is not the one that endorsed it
  const other = await approvalKeys(crypto.getRandomValues(new Uint8Array(32)));
  assertMatch((await run(await w.signed(), { ownerKey: other.public })).why!, /not the owner's/);
  // an answer to a request the hub no longer waits on
  assertEquals(
    (await run(await w.signed(w.body({ id: "c-aaa/r7", what: await wordsHash({ what: "x" }) })))).why,
    "nothing waits on that on this machine any more",
  );
  assertEquals(w.hub, []);
  // a good answer the hub cannot take: the child is not waiting on it any more
  w.setHubFails("c-aaa is not waiting on r1");
  assertEquals(await run(await w.signed()), { id: "c-aaa/r1", ok: false, why: "c-aaa is not waiting on r1" });
  assertEquals(w.hub, []);
});

Deno.test("node waiting: a yes signed on other words than the hub's own is refused, whatever the service says", async () => {
  const w = await world(), st = w.st();
  // the service showed the phone «git status» under the id of «git push»: the owner signed on that
  const shown = await wordsHash(boundWords("Bash: git status"));
  const [r] = await applyAnswers([await w.signed(w.body({ what: shown }))], st, w.deps);
  assertMatch(r.why!, /challenge/);
  assertEquals(w.hub, []);
  assertEquals(st.done, {}, "not remembered: the genuine answer is still to come");
  // the genuine one, signed on the words the hub holds, goes through
  assertEquals((await applyAnswers([await w.signed()], st, w.deps))[0].ok, true);
  // a `what` the service adds to the answer is not looked at
  const lying = { ...await w.signed(w.body({ what: shown })), what: w.hubWords["c-aaa/r1"] } as PhoneAnswer;
  assertMatch((await applyAnswers([lying], w.st(), w.deps))[0].why!, /challenge/);
});

Deno.test("node waiting: a passkey revoked in the vault is refused though the service still lists it endorsed", async () => {
  const w = await world();
  const [r] = await applyAnswers([await w.signed()], w.st(), {
    ...w.deps,
    revoked: () => Promise.resolve(new Set([w.passkey.id])),
  });
  assertEquals(r, { id: "c-aaa/r1", ok: false, why: "the passkey was revoked on a desktop" });
  assertEquals(w.hub, []);
  // a deny of a revoked passkey does not stop the agent either
  const [d] = await applyAnswers([await w.signed(w.body({ verdict: "deny" }))], w.st(), {
    ...w.deps,
    revoked: () => Promise.resolve(new Set([w.passkey.id])),
  });
  assertEquals(d.ok, false);
});

Deno.test("node waiting: passkeys that cannot be read leave the answer for the next try", async () => {
  const w = await world(), st = w.st();
  const a = await w.signed();
  w.setListing(new Error("HTTP 502"));
  assertEquals(await applyAnswers([a], st, w.deps), []);
  assertEquals(st.done, {}, "not remembered: the failure was ours");
  w.setListing([w.passkey]);
  assertEquals((await applyAnswers([a], st, w.deps))[0].ok, true);
});

// ---- the owner's side

Deno.test("passkeys: where one stands as this machine sees it, and the lines it prints", async () => {
  const w = await world();
  const stranger = await approvalKeys(crypto.getRandomValues(new Uint8Array(32)));
  assertEquals(await stateOf({ ...w.passkey, endorsement: null }, w.owner.public), "pending");
  assertEquals(await stateOf(w.passkey, w.owner.public), "endorsed");
  assertEquals(await stateOf(w.passkey, stranger.public), "not valid here");
  assertEquals(await stateOf(w.passkey, null), "endorsed (unchecked)");
  const rows = await rowsOf([w.passkey, { ...w.passkey, id: "zz" + w.passkey.id, endorsement: null }], w.owner.public);
  assertEquals(rows[0].fingerprint, await fingerprint(w.passkey.publicKey));
  const lines = passkeyLines(rows, NOW);
  assertEquals(lines.length, 2);
  assertMatch(lines[0], /Pixel\s+[0-9a-f]{4}(-[0-9a-f]{4}){3}\s+endorsed\s+1m? ?ago|now ago/);
  assertMatch(lines[1], /pending/);
  assertMatch(passkeyLines([], NOW)[0], /no passkey/);
});

Deno.test("passkeys: a revoked one says so, and a revoke names a listed passkey or a whole id", async () => {
  const w = await world();
  assertEquals(await stateOf(w.passkey, w.owner.public, new Set([w.passkey.id])), "revoked");
  assertEquals(await stateOf(w.passkey, w.owner.public, new Set(["other"])), "endorsed");
  const rows = await rowsOf([w.passkey], w.owner.public, new Set([w.passkey.id]));
  assertEquals(rows[0].state, "revoked");
  const list = [w.passkey];
  assertEquals(revokeTarget(list, w.passkey.id.slice(0, 8)), { id: w.passkey.id, name: "Pixel", listed: true });
  // a passkey the service no longer lists (revoked from the app) can still be written into the vault by its id
  const gone = "g".repeat(43);
  assertEquals(revokeTarget(list, gone), { id: gone, name: gone.slice(0, 12), listed: false });
  assertMatch(revokeTarget(list, "zz") as string, /no passkey zz/);
  assertMatch(revokeTarget(list, "") as string, /name a passkey/);
});

Deno.test("passkeys: a reference is an id or the start of one, and only when it is one passkey", () => {
  const p = (id: string): Passkey => ({ id, name: id, publicKey: "k", endorsement: null, created: "" });
  const list = [p("abc123"), p("abd456"), p("abc1234")];
  assertEquals((findPasskey(list, "abc123") as Passkey).id, "abc123", "the whole id beats a longer one it starts");
  assertEquals((findPasskey(list, "abd") as Passkey).id, "abd456");
  assertMatch(findPasskey(list, "ab") as string, /names 3 passkeys/);
  assertMatch(findPasskey(list, "zz") as string, /no passkey zz/);
  assertMatch(findPasskey(list, "") as string, /name a passkey/);
  assert(typeof findPasskey([], "a") === "string");
});
