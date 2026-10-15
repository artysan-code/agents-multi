// webauthn_test.ts — the phone's yes (shared/mcp/lib/webauthn.ts): a fake authenticator with a real P-256 key
// makes real authenticator data, client data and signatures (DER, as a device writes them), and every way an
// answer, a job or a registration can be refused is tried.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  type AnswerBody,
  answerChallenge,
  answerKey,
  answerText as answerTextOf,
  b64u,
  boundWords,
  cborAt,
  cleanAssertion,
  clientChallenge,
  endorsementText,
  fingerprint,
  jobChallenge,
  jobDeclineChallenge,
  jobDeclineText,
  parseRegistration,
  type Passkey,
  type PasskeyCtx,
  type PhoneAnswer,
  rawSignature,
  signEndorsement,
  siteOf,
  unb64u,
  verifyAnswer,
  verifyAssertion,
  verifyEndorsement,
  verifyJobAssertion,
  verifyJobDecline,
  wordsHash,
} from "../../../shared/mcp/lib/webauthn.ts";
import { Authenticator, cbytes, cint, coseKey, ctext, der, head, SITE } from "./fixtures/authenticator.ts";
import { approvalKeys, type Job, signedText, verifyJob } from "../../../shared/mcp/lib/nodes.ts";

const NOW = Date.parse("2026-10-15T20:00:00Z");
const sha = async (b: Uint8Array | string) =>
  new Uint8Array(
    await crypto.subtle.digest("SHA-256", typeof b === "string" ? new TextEncoder().encode(b) : b as BufferSource),
  );

// ---- the owner and a world around a passkey
async function world() {
  const vault = crypto.getRandomValues(new Uint8Array(32));
  const owner = await approvalKeys(vault);
  const phone = await Authenticator.make();
  const passkey: Passkey = {
    id: phone.id,
    name: "Pixel",
    publicKey: phone.publicKey,
    endorsement: null,
    created: "2026-10-15T19:00:00Z",
  };
  passkey.endorsement = await signEndorsement(passkey.id, passkey.publicKey, owner.sign);
  const ctx: PasskeyCtx = { site: SITE, passkeys: [passkey], ownerKey: owner.public, now: NOW };
  return { owner, phone, passkey, ctx };
}

/** the hash of the words of the request these answers are for: what the phone showed, what the node has */
const WHAT = await wordsHash(boundWords("Bash: git push origin dev"));

const body = (o: Partial<AnswerBody> = {}): AnswerBody => ({
  id: "child-1/req-7",
  node: "srv",
  verdict: "allow",
  expires: new Date(NOW + 5 * 60_000).toISOString(),
  what: WHAT,
  ...o,
});

async function answered(
  w: Awaited<ReturnType<typeof world>>,
  b = body(),
  o: Parameters<Authenticator["assert"]>[1] = {},
) {
  const { what: _what, ...rest } = b; // the service hands a node no `what`: the node has its own
  return { ...rest, assertion: await w.phone.assert(await answerChallenge(b), o) } as PhoneAnswer;
}

// ---------------------------------------------------------------- the pieces

Deno.test("cborAt reads the types WebAuthn uses and refuses the rest", () => {
  const [v, next] = cborAt(
    new Uint8Array([...head(5, 2), ...cint(1), ...cint(-7), ...ctext("a"), ...cbytes(new Uint8Array([1, 2]))]),
  );
  assertEquals(next, 8);
  const m = v as Map<number | string, unknown>;
  assertEquals(m.get(1), -7);
  assertEquals(m.get("a"), new Uint8Array([1, 2]));
  assertEquals(cborAt(new Uint8Array([0x19, 0x01, 0x00]))[0], 256);
  for (const bad of [[0x5f], [0x82, 1], [0x59, 0, 9, 1], [0xf9, 0, 0], [0xa1, 0x40, 0]]) {
    let thrown = false;
    try {
      cborAt(new Uint8Array(bad));
    } catch {
      thrown = true;
    }
    assert(thrown, `refused ${bad}`);
  }
});

Deno.test("base64url round trips and refuses what is not", () => {
  const b = crypto.getRandomValues(new Uint8Array(33));
  assertEquals(unb64u(b64u(b)), b);
  assertEquals(unb64u("a"), null);
  assertEquals(unb64u("ab+/"), null);
  assertEquals(unb64u(""), new Uint8Array());
});

Deno.test("rawSignature turns DER into r || s and keeps a raw signature", () => {
  const raw = crypto.getRandomValues(new Uint8Array(64));
  raw[0] = 0x90; // high bit: DER pads a zero
  raw[32] = 0; // leading zeros: DER drops them
  assertEquals(rawSignature(der(raw)), raw);
  assertEquals(rawSignature(raw.slice().fill(7)), raw.slice().fill(7));
  assertEquals(rawSignature(new Uint8Array([0x30, 3, 1, 2, 3])), null);
  assertEquals(rawSignature(new Uint8Array(10)), null);
  const bad = der(raw);
  assertEquals(rawSignature(bad.slice(0, bad.length - 1)), null);
});

Deno.test("siteOf: the origin keeps its port, the rpId does not", () => {
  assertEquals(siteOf("https://brain.example.org/"), {
    origin: "https://brain.example.org",
    rpId: "brain.example.org",
  });
  assertEquals(siteOf("http://localhost:8080"), { origin: "http://localhost:8080", rpId: "localhost" });
});

Deno.test("the fingerprint is stable, short and the key's own", async () => {
  const a = await Authenticator.make(), b = await Authenticator.make();
  assertMatch(await fingerprint(a.publicKey), /^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
  assertEquals(await fingerprint(a.publicKey), await fingerprint(a.publicKey));
  assert((await fingerprint(a.publicKey)) !== (await fingerprint(b.publicKey)));
});

Deno.test("cleanAssertion keeps four base64url parts and nothing else", async () => {
  const w = await world();
  const a = await w.phone.assert(await answerChallenge(body()));
  assertEquals(cleanAssertion({ ...a, extra: 1 }), a);
  assertEquals(cleanAssertion({ ...a, signature: "" }), null);
  assertEquals(cleanAssertion({ ...a, clientDataJSON: "not base64!" }), null);
  assertEquals(cleanAssertion({ ...a, signature: "A".repeat(500) }), null);
  assertEquals(cleanAssertion(null), null);
});

// ---------------------------------------------------------------- registration

Deno.test("a registration gives the id and the uncompressed public key", async () => {
  const p = await Authenticator.make();
  const reg = await p.register("chal-1");
  assertEquals(clientChallenge(reg.response.clientDataJSON), "chal-1");
  assertEquals(await parseRegistration(reg, "chal-1", SITE), { id: p.id, publicKey: p.publicKey });
});

Deno.test("a registration is refused for each thing that is wrong with it", async () => {
  const p = await Authenticator.make();
  const err = async (reg: Awaited<ReturnType<Authenticator["register"]>>, challenge = "c") =>
    (await parseRegistration(reg, challenge, SITE) as { error?: string }).error;
  assertMatch((await err(await p.register("other")))!, /challenge/);
  assertMatch((await err(await p.register("c", { type: "webauthn.get" })))!, /type/);
  assertMatch((await err(await p.register("c", { origin: "https://evil.example" })))!, /origin/);
  assertMatch((await err(await p.register("c", { fmt: "packed" })))!, /none only/);
  assertMatch((await err(await p.register("c", { rpId: "evil.example" })))!, /rpIdHash/);
  assertMatch((await err(await p.register("c", { flags: 0x40 | 0x04 })))!, /presence/);
  assertMatch((await err(await p.register("c", { flags: 0x40 | 0x01 })))!, /verification/);
  assertMatch((await err(await p.register("c", { flags: 0x01 | 0x04 })))!, /no credential/);
  assertMatch((await err(await p.register("c", { key: coseKey(p.point, { alg: -257 }) })))!, /ES256/);
  assertMatch((await err(await p.register("c", { key: coseKey(p.point, { crv: 2 }) })))!, /ES256/);
  assertMatch((await err(await p.register("c", { key: coseKey(p.point, { kty: 3 }) })))!, /ES256/);
  const off = p.point.slice();
  off[40] ^= 1;
  assertMatch((await err(await p.register("c", { key: coseKey(off) })))!, /not a point/);
  const reg = await p.register("c");
  assertMatch((await err({ ...reg, id: "AAAA" }))!, /differs/);
  assertMatch(
    (await err({ id: p.id, response: { ...reg.response, attestationObject: "AAAA" } }))!,
    /attestation object/,
  );
  assertMatch((await err({ id: p.id, response: { ...reg.response, clientDataJSON: "AAAA" } }))!, /not JSON/);
});

// ---------------------------------------------------------------- endorsement

Deno.test("an endorsement holds only with the owner's key, for that passkey and key", async () => {
  const w = await world();
  assertEquals(await verifyEndorsement(w.passkey, w.owner.public), true);
  const other = await approvalKeys(crypto.getRandomValues(new Uint8Array(32)));
  assertEquals(await verifyEndorsement(w.passkey, other.public), false);
  assertEquals(await verifyEndorsement({ ...w.passkey, id: "x" + w.passkey.id }, w.owner.public), false);
  assertEquals(await verifyEndorsement({ ...w.passkey, publicKey: b64u(new Uint8Array(65)) }, w.owner.public), false);
  assertEquals(await verifyEndorsement({ ...w.passkey, endorsement: null }, w.owner.public), false);
  assertEquals(endorsementText("a", "b"), "agents-multi passkey v1\na\nb");
});

// ---------------------------------------------------------------- assertions and answers

Deno.test("an endorsed passkey's answer holds, with a DER signature or a raw one", async () => {
  const w = await world();
  assertEquals(await verifyAnswer(await answered(w), WHAT, "srv", w.ctx, []), null);
  assertEquals(await verifyAnswer(await answered(w, body(), { derSig: false }), WHAT, "srv", w.ctx, []), null);
  const withAnswers = body({ answers: { "Which?": "A" }, verdict: "allow" });
  assertEquals(await verifyAnswer(await answered(w, withAnswers), WHAT, "srv", w.ctx, []), null);
});

Deno.test("the challenge is bound to every field of the answer", async () => {
  const w = await world();
  const good = await answered(w);
  const t = async (patch: Partial<PhoneAnswer>) =>
    await verifyAnswer({ ...good, ...patch }, WHAT, patch.node ?? "srv", w.ctx, []);
  assertMatch((await t({ verdict: "deny" }))!, /challenge/);
  assertMatch((await t({ id: "child-1/req-8" }))!, /challenge/);
  assertMatch((await t({ node: "other" }))!, /challenge/);
  assertMatch((await t({ answers: { q: "a" } }))!, /challenge/);
  assertMatch((await t({ expires: new Date(NOW + 9 * 60_000).toISOString() }))!, /challenge/);
});

Deno.test("an answer is refused for each way it can be wrong", async () => {
  const w = await world();
  const good = await answered(w);
  assertEquals(await verifyAnswer(good, WHAT, "desk", w.ctx, []), "it is for srv, not desk");
  assertEquals(
    await verifyAnswer({ ...good, verdict: "maybe" as never }, WHAT, "srv", w.ctx, []),
    "the verdict is allow, session or deny",
  );
  assertMatch(
    (await verifyAnswer({ ...good, answers: { q: 1 } as never }, WHAT, "srv", w.ctx, []))!,
    /text by question/,
  );
  assertMatch((await verifyAnswer({ ...good, expires: "soon" }, WHAT, "srv", w.ctx, []))!, /no expiry/);
  assertEquals(await verifyAnswer(good, WHAT, "srv", { ...w.ctx, now: NOW + 6 * 60_000 }, []), "its approval expired");
  const far = await answered(w, body({ expires: new Date(NOW + 30 * 60_000).toISOString() }));
  assertEquals(await verifyAnswer(far, WHAT, "srv", w.ctx, []), "it holds longer than ten minutes");
  assertEquals(
    await verifyAnswer({ ...good, assertion: { ...good.assertion, signature: "" } }, WHAT, "srv", w.ctx, []),
    "the assertion lacks a part",
  );
  assertEquals(
    await verifyAnswer(good, WHAT, "srv", w.ctx, [await answerKey({ ...good, what: WHAT })]),
    "already used",
  );
});

Deno.test("an answer needs a known passkey the owner endorsed, and a node that can check it", async () => {
  const w = await world();
  const good = await answered(w);
  assertEquals(await verifyAnswer(good, WHAT, "srv", { ...w.ctx, passkeys: [] }, []), "not a passkey of this account");
  assertEquals(
    await verifyAnswer(good, WHAT, "srv", { ...w.ctx, passkeys: [{ ...w.passkey, endorsement: null }] }, []),
    "the passkey has not been endorsed on a desktop",
  );
  // the service (or a thief with its token) endorses with a key of its own
  const thief = await approvalKeys(crypto.getRandomValues(new Uint8Array(32)));
  const forged = { ...w.passkey, endorsement: await signEndorsement(w.passkey.id, w.passkey.publicKey, thief.sign) };
  assertEquals(
    await verifyAnswer(good, WHAT, "srv", { ...w.ctx, passkeys: [forged] }, []),
    "the passkey's endorsement is not the owner's",
  );
  assertMatch((await verifyAnswer(good, WHAT, "srv", { ...w.ctx, ownerKey: null }, []))!, /no approval key/);
  // another passkey's signature on the same challenge, claiming the endorsed passkey's id
  const mallory = await Authenticator.make();
  const swapped = {
    ...good,
    assertion: { ...(await mallory.assert(await answerChallenge(body()))), credential: w.phone.id },
  };
  assertEquals(await verifyAnswer(swapped, WHAT, "srv", w.ctx, []), "the signature is not the passkey's");
});

Deno.test("the assertion's own checks: type, origin, frame, rpIdHash, presence, verification, signature", async () => {
  const w = await world();
  const c = await answerChallenge(body());
  const v = async (o: Parameters<Authenticator["assert"]>[1]) =>
    await verifyAssertion(await w.phone.assert(c, o), w.phone.publicKey, c, SITE);
  assertEquals(await v({}), null);
  assertMatch((await v({ type: "webauthn.create" }))!, /type/);
  assertMatch((await v({ origin: "https://evil.example" }))!, /origin/);
  assertMatch((await v({ crossOrigin: true }))!, /another origin/);
  assertMatch((await v({ rpId: "evil.example" }))!, /rpIdHash/);
  assertMatch((await v({ flags: 0x04 }))!, /presence/);
  assertMatch((await v({ flags: 0x01 }))!, /verification/);
  const a = await w.phone.assert(c);
  assertMatch(
    (await verifyAssertion({ ...a, authenticatorData: b64u(new Uint8Array(36)) }, w.phone.publicKey, c, SITE))!,
    /too short/,
  );
  assertMatch((await verifyAssertion(a, w.phone.publicKey, await sha("another"), SITE))!, /challenge/);
  const flipped = unb64u(a.signature)!;
  flipped[flipped.length - 1] ^= 1;
  assertMatch((await verifyAssertion({ ...a, signature: b64u(flipped) }, w.phone.publicKey, c, SITE))!, /signature/);
  assertMatch(
    (await verifyAssertion({ ...a, signature: b64u(new Uint8Array(5)) }, w.phone.publicKey, c, SITE))!,
    /ES256/,
  );
  // another origin on the same host (a port) is another site
  assertMatch((await verifyAssertion(a, w.phone.publicKey, c, siteOf("https://brain.example.org:8443")))!, /origin/);
});

// ---------------------------------------------------------------- a job accepted from the phone

const job = (o: Partial<Job> = {}): Job => ({
  id: "j-1",
  node: "srv",
  kind: "routine",
  spec: { name: "nightly", repo: "git.example/a/b", path: "", action: { kind: "agent", profile: "personal" } },
  status: "accepted",
  expires: new Date(NOW + 3600_000).toISOString(),
  created: new Date(NOW - 1000).toISOString(),
  updated: new Date(NOW - 1000).toISOString(),
  by: "desk",
  ...o,
});

Deno.test("verifyJob takes a job approved by an endorsed passkey as well as the Ed25519 signature", async () => {
  const w = await world();
  const j = job();
  j.assertion = await w.phone.assert(await jobChallenge(j));
  const via = (x: Job) => verifyJobAssertion(x, w.ctx);
  assertEquals(await verifyJob(j, w.owner.public, "srv", NOW, [], via), null);
  // every other check of verifyJob still stands
  assertEquals(await verifyJob(j, w.owner.public, "desk", NOW, [], via), "it is for srv, not desk");
  assertEquals(await verifyJob(j, w.owner.public, "srv", NOW + 2 * 3600_000, [], via), "its approval expired");
  assertEquals(await verifyJob(j, w.owner.public, "srv", NOW, ["j-1"], via), "already run here");
  assertEquals(
    await verifyJob(j, w.owner.public, "srv", NOW, []),
    "approved by a passkey, which this node cannot check",
  );
  // the assertion is over this job's text: another spec, node or expiry breaks it
  assertMatch(
    (await verifyJob({ ...j, spec: { ...j.spec, name: "evil" } }, w.owner.public, "srv", NOW, [], via))!,
    /challenge/,
  );
  assertMatch(
    (await verifyJob({ ...j, expires: new Date(NOW + 7200_000).toISOString() }, w.owner.public, "srv", NOW, [], via))!,
    /challenge/,
  );
  // an unendorsed passkey does not count
  const unendorsed = { ...w.ctx, passkeys: [{ ...w.passkey, endorsement: null }] };
  assertEquals(
    await verifyJob(j, w.owner.public, "srv", NOW, [], (x) => verifyJobAssertion(x, unendorsed)),
    "the passkey has not been endorsed on a desktop",
  );
  // neither a signature nor an assertion
  assertEquals(await verifyJob({ ...j, assertion: undefined }, w.owner.public, "srv", NOW, [], via), "not signed");
  assertEquals(signedText(j).startsWith("agents-multi job v1\n"), true);
});

Deno.test("a job's signature still counts, and wins when both are there", async () => {
  const w = await world();
  const j = job();
  const { signJob } = await import("../../../shared/mcp/lib/nodes.ts");
  j.signature = await signJob(j, w.owner.sign);
  assertEquals(await verifyJob(j, w.owner.public, "srv", NOW, []), null);
  assertEquals(
    await verifyJob({ ...j, signature: j.signature.slice(0, -2) + "AA" }, w.owner.public, "srv", NOW, []),
    "the signature is not the owner's",
  );
});

// ---------------------------------------------------------------- the tighter yes (ADR 0014, second round)

Deno.test("the challenge of an answer is v2 and binds the request's words", async () => {
  const b = body();
  assert(answerTextOf(b).startsWith("agents-multi answer v2\n"));
  assertEquals(
    answerTextOf(b),
    `agents-multi answer v2\n{"expires":"${b.expires}","id":"child-1/req-7","node":"srv","verdict":"allow","what":"${WHAT}"}`,
  );
  assertEquals(b64u(await answerChallenge(b)), b64u(await sha(answerTextOf(b))));
});

Deno.test("a service that showed the phone other words gets a signature that fails", async () => {
  const w = await world();
  // the node's hub waits on this; the phone was shown something else under the same id
  const real = await wordsHash(boundWords("Bash: git push origin dev"));
  const shown = await wordsHash(boundWords("Bash: git status"));
  assert(real !== shown);
  const signedOnOtherWords = await answered(w, body({ what: shown }));
  assertMatch((await verifyAnswer(signedOnOtherWords, real, "srv", w.ctx, []))!, /challenge/);
  assertEquals(
    await verifyAnswer(signedOnOtherWords, shown, "srv", w.ctx, []),
    null,
    "the same answer holds for the words it was signed on",
  );
  // the questions count as words as well, option by option
  const q = (label: string) => boundWords("Which?", [{ question: "Which?", options: [{ label }, { label: "B" }] }]);
  assert((await wordsHash(q("A"))) !== (await wordsHash(q("C"))));
  assert((await wordsHash(boundWords("Which?"))) !== (await wordsHash(q("A"))));
  const withQuestions = await answered(w, body({ what: await wordsHash(q("A")) }));
  assertEquals(await verifyAnswer(withQuestions, await wordsHash(q("A")), "srv", w.ctx, []), null);
  assertMatch((await verifyAnswer(withQuestions, await wordsHash(q("C")), "srv", w.ctx, []))!, /challenge/);
});

Deno.test("the words are bounded once and hashed the same by whoever holds them", async () => {
  const long = boundWords("x".repeat(5000), [
    {
      question: "q".repeat(900),
      header: "h".repeat(90),
      options: Array.from({ length: 12 }, (_, i) => ({ label: `o${i}`, extra: 1 })),
      extra: 1,
    },
    ...Array.from({ length: 6 }, () => ({ question: "more", options: [] })),
  ]);
  assertEquals(long.what.length, 1000);
  assertEquals(long.questions!.length, 4);
  assertEquals(long.questions![0].question.length, 500);
  assertEquals(long.questions![0].header!.length, 60);
  assertEquals(long.questions![0].options.length, 8);
  assertEquals(boundWords(long.what, long.questions), long, "bounding what is bounded changes nothing");
  // the node relays JSON; the service stores it; the phone parses it: the hash survives all of it
  const trip = JSON.parse(JSON.stringify(long));
  assertEquals(await wordsHash(trip), await wordsHash(long));
  assertEquals(await wordsHash({ what: "a" }), await wordsHash({ what: "a", questions: undefined }));
  assertEquals(boundWords(7 as never), { what: "" });
});

Deno.test("an answer in the first format (v1) is refused, named as such", async () => {
  const w = await world();
  const b = body();
  const v1 = `agents-multi answer v1\n{"expires":"${b.expires}","id":"${b.id}","node":"srv","verdict":"allow"}`;
  const { what: _w, ...rest } = b;
  const old = { ...rest, assertion: await w.phone.assert(await sha(v1)) } as PhoneAnswer;
  assertMatch((await verifyAnswer(old, WHAT, "srv", w.ctx, []))!, /old format \(v1\)/);
});

Deno.test("a passkey revoked on a desktop is refused whatever the service lists", async () => {
  const w = await world();
  const good = await answered(w);
  assertEquals(await verifyAnswer(good, WHAT, "srv", { ...w.ctx, revoked: new Set(["another"]) }, []), null);
  assertEquals(
    await verifyAnswer(good, WHAT, "srv", { ...w.ctx, revoked: new Set([w.passkey.id]) }, []),
    "the passkey was revoked on a desktop",
  );
  // a job it approved, and a decline it signed, go the same way
  const j = job();
  j.assertion = await w.phone.assert(await jobChallenge(j));
  assertEquals(
    await verifyJobAssertion(j, { ...w.ctx, revoked: new Set([w.passkey.id]) }),
    "the passkey was revoked on a desktop",
  );
});

// ---------------------------------------------------------------- declining a job from the phone

const declined = async (w: Awaited<ReturnType<typeof world>>, o: Partial<Job> = {}, sign: Partial<Job> = {}) => {
  const j = job({ status: "declined", node: "srv", updated: new Date(NOW).toISOString(), ...o });
  const signed = { ...j, ...sign };
  j.assertion = await w.phone.assert(await jobDeclineChallenge(signed));
  return j as Job & { updated: string };
};

Deno.test("a decline from the phone is signed over its own text", async () => {
  const w = await world();
  assert(jobDeclineText(job()).startsWith("agents-multi job decline v1\n"));
  assert(jobDeclineText(job()) !== signedText(job()), "not the text of an approval");
  const j = await declined(w);
  assertEquals(await verifyJobDecline(j, w.ctx), null);
  // every field of the job is in it
  assertMatch((await verifyJobDecline({ ...j, spec: { ...j.spec, name: "other" } }, w.ctx))!, /challenge/);
  assertMatch((await verifyJobDecline({ ...j, node: "desk" }, w.ctx))!, /challenge/);
  assertMatch((await verifyJobDecline({ ...j, id: "j-2" }, w.ctx))!, /challenge/);
  assertMatch((await verifyJobDecline({ ...j, expires: new Date(NOW + 60_000).toISOString() }, w.ctx))!, /challenge/);
});

Deno.test("an approval cannot be passed off as a decline, nor a decline as an approval", async () => {
  const w = await world();
  const j = job({ status: "declined", updated: new Date(NOW).toISOString() });
  j.assertion = await w.phone.assert(await jobChallenge(j)); // the phone said yes to this job
  assertMatch((await verifyJobDecline(j as never, w.ctx))!, /challenge/);
  const d = await declined(w);
  assertMatch((await verifyJobAssertion(d, w.ctx))!, /challenge/);
});

Deno.test("a decline needs a passkey the owner endorsed and does not wait on the clock of the node", async () => {
  const w = await world();
  const j = await declined(w);
  assertEquals(await verifyJobDecline({ ...j, assertion: undefined }, w.ctx), "the decline carries no assertion");
  assertEquals(await verifyJobDecline({ ...j, expires: undefined }, w.ctx), "no expiry");
  assertEquals(
    await verifyJobDecline(j, { ...w.ctx, passkeys: [{ ...w.passkey, endorsement: null }] }),
    "the passkey has not been endorsed on a desktop",
  );
  assertEquals(await verifyJobDecline(j, { ...w.ctx, passkeys: [] }), "not a passkey of this account");
  assertMatch((await verifyJobDecline(j, { ...w.ctx, ownerKey: null }))!, /no approval key/);
  // read a day later by a node that was off: it still holds
  assertEquals(await verifyJobDecline(j, { ...w.ctx, now: NOW + 20 * 3600_000 }), null);
  // but it was never valid if it had run out when it was made, or reached for more than a day
  const past = await declined(w, { expires: new Date(NOW - 10 * 60_000).toISOString() });
  assertEquals(await verifyJobDecline(past, w.ctx), "the decline had expired when it was made");
  const far = await declined(w, { expires: new Date(NOW + 3 * 24 * 3600_000).toISOString() });
  assertEquals(await verifyJobDecline(far, w.ctx), "it holds longer than a day");
  // someone else's key signing under the passkey's id
  const mallory = await Authenticator.make();
  const swapped = {
    ...j,
    assertion: { ...(await mallory.assert(await jobDeclineChallenge(j))), credential: w.phone.id },
  };
  assertEquals(await verifyJobDecline(swapped, w.ctx), "the signature is not the passkey's");
});
