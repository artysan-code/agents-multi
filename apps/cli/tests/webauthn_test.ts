// webauthn_test.ts — the phone's yes (shared/mcp/lib/webauthn.ts): a fake authenticator with a real P-256 key
// makes real authenticator data, client data and signatures (DER, as a device writes them), and every way an
// answer, a job or a registration can be refused is tried.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  type AnswerBody,
  answerChallenge,
  answerKey,
  b64u,
  cborAt,
  cleanAssertion,
  clientChallenge,
  endorsementText,
  fingerprint,
  jobChallenge,
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

const body = (o: Partial<AnswerBody> = {}): AnswerBody => ({
  id: "child-1/req-7",
  node: "srv",
  verdict: "allow",
  expires: new Date(NOW + 5 * 60_000).toISOString(),
  ...o,
});

async function answered(
  w: Awaited<ReturnType<typeof world>>,
  b = body(),
  o: Parameters<Authenticator["assert"]>[1] = {},
) {
  return { ...b, assertion: await w.phone.assert(await answerChallenge(b), o) } as PhoneAnswer;
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
  assertEquals(await verifyAnswer(await answered(w), "srv", w.ctx, []), null);
  assertEquals(await verifyAnswer(await answered(w, body(), { derSig: false }), "srv", w.ctx, []), null);
  const withAnswers = body({ answers: { "Which?": "A" }, verdict: "allow" });
  assertEquals(await verifyAnswer(await answered(w, withAnswers), "srv", w.ctx, []), null);
});

Deno.test("the challenge is bound to every field of the answer", async () => {
  const w = await world();
  const good = await answered(w);
  const t = async (patch: Partial<PhoneAnswer>) =>
    await verifyAnswer({ ...good, ...patch }, patch.node ?? "srv", w.ctx, []);
  assertMatch((await t({ verdict: "deny" }))!, /challenge/);
  assertMatch((await t({ id: "child-1/req-8" }))!, /challenge/);
  assertMatch((await t({ node: "other" }))!, /challenge/);
  assertMatch((await t({ answers: { q: "a" } }))!, /challenge/);
  assertMatch((await t({ expires: new Date(NOW + 9 * 60_000).toISOString() }))!, /challenge/);
});

Deno.test("an answer is refused for each way it can be wrong", async () => {
  const w = await world();
  const good = await answered(w);
  assertEquals(await verifyAnswer(good, "desk", w.ctx, []), "it is for srv, not desk");
  assertEquals(
    await verifyAnswer({ ...good, verdict: "maybe" as never }, "srv", w.ctx, []),
    "the verdict is allow, session or deny",
  );
  assertMatch((await verifyAnswer({ ...good, answers: { q: 1 } as never }, "srv", w.ctx, []))!, /text by question/);
  assertMatch((await verifyAnswer({ ...good, expires: "soon" }, "srv", w.ctx, []))!, /no expiry/);
  assertEquals(await verifyAnswer(good, "srv", { ...w.ctx, now: NOW + 6 * 60_000 }, []), "its approval expired");
  const far = await answered(w, body({ expires: new Date(NOW + 30 * 60_000).toISOString() }));
  assertEquals(await verifyAnswer(far, "srv", w.ctx, []), "it holds longer than ten minutes");
  assertEquals(
    await verifyAnswer({ ...good, assertion: { ...good.assertion, signature: "" } }, "srv", w.ctx, []),
    "the assertion lacks a part",
  );
  assertEquals(await verifyAnswer(good, "srv", w.ctx, [await answerKey(good)]), "already used");
});

Deno.test("an answer needs a known passkey the owner endorsed, and a node that can check it", async () => {
  const w = await world();
  const good = await answered(w);
  assertEquals(await verifyAnswer(good, "srv", { ...w.ctx, passkeys: [] }, []), "not a passkey of this account");
  assertEquals(
    await verifyAnswer(good, "srv", { ...w.ctx, passkeys: [{ ...w.passkey, endorsement: null }] }, []),
    "the passkey has not been endorsed on a desktop",
  );
  // the service (or a thief with its token) endorses with a key of its own
  const thief = await approvalKeys(crypto.getRandomValues(new Uint8Array(32)));
  const forged = { ...w.passkey, endorsement: await signEndorsement(w.passkey.id, w.passkey.publicKey, thief.sign) };
  assertEquals(
    await verifyAnswer(good, "srv", { ...w.ctx, passkeys: [forged] }, []),
    "the passkey's endorsement is not the owner's",
  );
  assertMatch((await verifyAnswer(good, "srv", { ...w.ctx, ownerKey: null }, []))!, /no approval key/);
  // another passkey's signature on the same challenge, claiming the endorsed passkey's id
  const mallory = await Authenticator.make();
  const swapped = {
    ...good,
    assertion: { ...(await mallory.assert(await answerChallenge(body()))), credential: w.phone.id },
  };
  assertEquals(await verifyAnswer(swapped, "srv", w.ctx, []), "the signature is not the passkey's");
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
