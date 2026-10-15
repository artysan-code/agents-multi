// waiting_test.ts — what waits on the machines and the phone's yes (waiting.ts, G5): the requests a node
// relays, a passkey's registration and endorsement, the answers the service keeps for the node to check, and a
// job accepted from the phone. On a brain database in memory, through the routes. The service decides nothing:
// every refusal that matters is the node's (apps/cli/tests/webauthn_test.ts).
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { cleanRequest, Waiting, waitingRoute } from "../waiting.ts";
import { Fleet, fleetRoute } from "../fleet.ts";
import { Store } from "../store.ts";
import { answerChallenge, jobChallenge } from "../../../shared/mcp/lib/webauthn.ts";
import { Authenticator, SITE } from "../../cli/tests/fixtures/authenticator.ts";

const NOW0 = Date.parse("2026-10-15T20:00:00Z");
const req = (id = "c1/r1", x: Record<string, unknown> = {}) => ({
  id,
  child: id.split("/")[0],
  request: id.split("/")[1],
  profile: "work",
  project: "/home/a/proj",
  kind: "request",
  what: "Bash: git push",
  ...x,
});

function setup() {
  let now = NOW0, n = 0;
  const db = new Store(":memory:").db;
  const w = new Waiting(db, SITE, () => now, () => `chal-${++n}`);
  const fleet = new Fleet(db, () => now, () => `j${++n}`);
  const call = async (node: string | null, method: string, path: string, body?: unknown, phone = false) => {
    const r = new Request(`https://b.test${path}`, { method, body: body ? JSON.stringify(body) : undefined });
    const u = new URL(r.url);
    const res = (await waitingRoute(r, u, node, w, () => fleet.jobs().filter((j) => j.status === "proposed"), "u1")) ??
      (await fleetRoute(r, u, node, fleet, (me) => ({ answers: w.pending(me) }), phone));
    return { status: res!.status, body: await res!.json() };
  };
  return { w, fleet, call, tick: (ms: number) => (now += ms), now: () => now };
}

/** A phone with an endorsed-or-not passkey registered through the routes. */
async function phone(s: ReturnType<typeof setup>) {
  const p = await Authenticator.make();
  const opts = await s.call(null, "POST", "/api/passkeys/options");
  const reg = await p.register(opts.body.challenge);
  const r = await s.call(null, "POST", "/api/passkeys", { name: "Pixel", credential: reg });
  return { p, opts, r };
}

Deno.test("waiting: a request is kept with known fields; its id is its child and its request", () => {
  assertEquals(cleanRequest(req())!.what, "Bash: git push");
  assertEquals(cleanRequest(req("c1/r1", { id: "c1/other" })), null);
  assertEquals(cleanRequest(req("c 1/r1")), null);
  assertEquals(cleanRequest(req("c1/r1", { kind: "done" })), null);
  assertEquals(cleanRequest(req("c1/r1", { extra: 1 }))!.extra, undefined);
  const q = cleanRequest(req("c1/r2", {
    kind: "question",
    questions: [{ question: "Which?", options: [{ label: "A", description: "a" }, "junk"], multiSelect: true }],
  }))!;
  assertEquals((q.questions as { options: unknown[] }[])[0].options.length, 2);
});

Deno.test("waiting: a node's list replaces its own, the phone reads all with the proposed jobs", async () => {
  const s = setup();
  assertEquals((await s.call("desk", "PUT", "/api/node/requests", { requests: [req("a/1"), req("a/2")] })).body.n, 2);
  await s.call("srv", "PUT", "/api/node/requests", { requests: [req("b/1")] });
  await s.call("desk", "PUT", "/api/node/requests", { requests: [req("a/2"), { nonsense: true }] });
  // a proposal waits too
  await s.call("desk", "PUT", "/api/node", { platform: "linux" });
  await s.call("desk", "POST", "/api/jobs", {
    kind: "routine",
    node: "srv",
    spec: { name: "n", repo: "r", path: "", action: { kind: "agent" } },
  });
  const got = (await s.call(null, "GET", "/api/waiting")).body;
  assertEquals(got.requests.map((r: { id: string; node: string }) => `${r.node}:${r.id}`), ["desk:a/2", "srv:b/1"]);
  assertEquals(got.jobs.length, 1);
  assertEquals(got.jobs[0].status, "proposed");
  // only a machine relays; a node silent for ten minutes is no longer shown as waiting
  assertEquals((await s.call(null, "PUT", "/api/node/requests", { requests: [] })).status, 403);
  s.tick(11 * 60_000);
  assertEquals((await s.call(null, "GET", "/api/waiting")).body.requests, []);
});

Deno.test("waiting: a passkey is registered pending, endorsed by a machine, listed and revoked", async () => {
  const s = setup();
  const { p, opts, r } = await phone(s);
  assertEquals(opts.body.attestation, "none");
  assertEquals(opts.body.pubKeyCredParams, [{ type: "public-key", alg: -7 }]);
  assertEquals(opts.body.rp.id, "brain.example.org");
  assertEquals(r.body, { id: p.id, state: "pending" });
  let list = (await s.call(null, "GET", "/api/passkeys")).body;
  assertEquals(list.length, 1);
  assertEquals([list[0].id, list[0].name, list[0].publicKey, list[0].endorsement], [p.id, "Pixel", p.publicKey, null]);
  // registered again: its challenge was used, and it is the same passkey
  const again = await s.call(null, "POST", "/api/passkeys", {
    name: "x",
    credential: await p.register(opts.body.challenge),
  });
  assertEquals(again.status, 400);
  // the web session never endorses; a machine does, and the service keeps what it is given
  const sig = "A".repeat(86);
  assertEquals((await s.call(null, "POST", `/api/passkeys/${p.id}/endorse`, { signature: sig }, true)).status, 403);
  assertEquals((await s.call("desk", "POST", `/api/passkeys/${p.id}/endorse`, { signature: "short" })).status, 400);
  assertEquals((await s.call("desk", "POST", `/api/passkeys/nope/endorse`, { signature: sig })).status, 404);
  assertEquals((await s.call("desk", "POST", `/api/passkeys/${p.id}/endorse`, { signature: sig })).status, 200);
  list = (await s.call(null, "GET", "/api/passkeys")).body;
  assertEquals(list[0].endorsement, sig);
  // the next registration excludes it
  assertEquals((await s.call(null, "POST", "/api/passkeys/options")).body.excludeCredentials, [{
    type: "public-key",
    id: p.id,
  }]);
  assertEquals((await s.call(null, "DELETE", `/api/passkeys/${p.id}`)).status, 200);
  assertEquals((await s.call(null, "DELETE", `/api/passkeys/${p.id}`)).status, 404);
  assertEquals((await s.call(null, "GET", "/api/passkeys")).body, []);
});

Deno.test("waiting: a registration needs a challenge the service made, once, in time, and a valid credential", async () => {
  const s = setup();
  const p = await Authenticator.make();
  const post = async (reg: unknown) =>
    (await s.call(null, "POST", "/api/passkeys", { name: "P", credential: reg })).body.error;
  assertMatch(await post(await p.register("never-made")), /unknown or expired/);
  const old = (await s.call(null, "POST", "/api/passkeys/options")).body.challenge;
  s.tick(6 * 60_000);
  assertMatch(await post(await p.register(old)), /unknown or expired/);
  const c = (await s.call(null, "POST", "/api/passkeys/options")).body.challenge;
  assertMatch(await post(await p.register(c, { fmt: "packed" })), /none only/);
  // a failed attempt used the challenge up
  assertMatch(await post(await p.register(c)), /unknown or expired/);
  const d = (await s.call(null, "POST", "/api/passkeys/options")).body.challenge;
  assertMatch(await post(await p.register(d, { origin: "https://evil.example" })), /origin/);
  assertEquals((await s.call(null, "POST", "/api/passkeys", { name: "P" })).status, 400);
});

Deno.test("waiting: the phone's answer is stored for its node, never decided, and the node reports how it ended", async () => {
  const s = setup();
  const { p } = await phone(s);
  await s.call("srv", "PUT", "/api/node/requests", { requests: [req("c1/r1")] });
  const body = (x: Record<string, unknown> = {}) => ({
    id: "c1/r1",
    node: "srv",
    verdict: "allow" as const,
    expires: new Date(s.now() + 5 * 60_000).toISOString(),
    ...x,
  });
  const signed = async (b = body()) => ({
    verdict: b.verdict,
    expires: b.expires,
    assertion: await p.assert(await answerChallenge(b)),
  });
  // refusals at the door (the shape; the signature is the node's to check)
  assertEquals((await s.call(null, "POST", "/api/waiting/c1/zz", await signed())).status, 404);
  assertEquals(
    (await s.call(null, "POST", "/api/waiting/c1%2Fr1", { ...await signed(), verdict: "maybe" })).status,
    400,
  );
  assertEquals(
    (await s.call(null, "POST", "/api/waiting/c1/r1", { ...await signed(), answers: { q: 1 } })).status,
    400,
  );
  assertEquals((await s.call(null, "POST", "/api/waiting/c1/r1", { ...await signed(), expires: "soon" })).status, 400);
  const far = new Date(s.now() + 30 * 60_000).toISOString();
  assertEquals((await s.call(null, "POST", "/api/waiting/c1/r1", { ...await signed(), expires: far })).status, 400);
  assertEquals((await s.call(null, "POST", "/api/waiting/c1/r1", { ...await signed(), assertion: {} })).status, 400);
  const stranger = await Authenticator.make();
  const bad = { ...await signed(), assertion: await stranger.assert(await answerChallenge(body())) };
  assertEquals((await s.call(null, "POST", "/api/waiting/c1/r1", bad)).body.error, "not a passkey of this account");
  // accepted: stored as given, even with a signature that is wrong for it (the node refuses that)
  const ok = await s.call(null, "POST", "/api/waiting/c1/r1", await signed());
  assertEquals(ok.body, { id: "c1/r1", state: "pending" });
  assertEquals((await s.call(null, "POST", "/api/waiting/c1/r1", await signed())).status, 409);
  // the node gets it from its own poll and from its announce's reply, and nobody else's node does
  const mine = (await s.call("srv", "GET", "/api/node/answers")).body.answers;
  assertEquals(mine.length, 1);
  assertEquals([mine[0].id, mine[0].node, mine[0].verdict], ["c1/r1", "srv", "allow"]);
  assertEquals(mine[0].assertion.credential, p.id);
  assertEquals((await s.call("srv", "PUT", "/api/node", { platform: "linux" })).body.answers.length, 1);
  assertEquals((await s.call("desk", "GET", "/api/node/answers")).body.answers, []);
  assertEquals((await s.call(null, "GET", "/api/node/answers")).status, 403);
  // the node refuses it and says why; the phone sees that, and may answer again
  assertEquals((await s.call("desk", "POST", "/api/node/answers", { results: [{ id: "c1/r1", ok: true }] })).body.n, 0);
  assertEquals(
    (await s.call("srv", "POST", "/api/node/answers", { results: [{ id: "c1/r1", ok: false, why: "not endorsed" }] }))
      .body.n,
    1,
  );
  assertEquals((await s.call("srv", "GET", "/api/node/answers")).body.answers, []);
  const seen = (await s.call(null, "GET", "/api/waiting")).body.answers;
  assertEquals([seen[0].state, seen[0].why], ["refused", "not endorsed"]);
  assertEquals((await s.call(null, "POST", "/api/waiting/c1/r1", await signed())).status, 200);
  // an answer nobody fetched in time lapses
  s.tick(6 * 60_000);
  assertEquals((await s.call("srv", "GET", "/api/node/answers")).body.answers, []);
  assertEquals((await s.call(null, "GET", "/api/waiting")).body.answers[0].state, "refused");
});

Deno.test("waiting: a question's answers travel with the verdict, and the same id on two nodes needs the node", async () => {
  const s = setup();
  const { p } = await phone(s);
  await s.call("srv", "PUT", "/api/node/requests", { requests: [req("c1/r1", { kind: "question" })] });
  await s.call("desk", "PUT", "/api/node/requests", { requests: [req("c1/r1")] });
  const b = {
    id: "c1/r1",
    node: "srv",
    verdict: "allow" as const,
    answers: { "Which?": "A" },
    expires: new Date(s.now() + 60_000).toISOString(),
  };
  const r = await s.call(null, "POST", "/api/waiting/c1/r1", {
    ...b,
    assertion: await p.assert(await answerChallenge(b)),
  });
  assertEquals(r.status, 200);
  const mine = (await s.call("srv", "GET", "/api/node/answers")).body.answers;
  assertEquals(mine.length + (await s.call("desk", "GET", "/api/node/answers")).body.answers.length, 1);
  assertEquals(mine.length === 1 ? mine[0].answers : null, { "Which?": "A" });
});

Deno.test("jobs: the phone accepts a proposal with an assertion, declines it, and does nothing else", async () => {
  const s = setup();
  const { p } = await phone(s);
  const spec = { name: "n", repo: "r", path: "", action: { kind: "agent" } };
  const id = (await s.call("desk", "POST", "/api/jobs", { kind: "routine", node: "srv", spec })).body.job.id;
  const expires = new Date(s.now() + 3600_000).toISOString();
  const assertion = await p.assert(
    await jobChallenge({ id, node: "srv", kind: "routine", spec, expires }),
  );
  // a Claude connection (a token that is no machine's, not the web session) acts on nothing
  assertEquals((await s.call(null, "POST", `/api/jobs/${id}`, { op: "accept", assertion, expires })).status, 403);
  assertEquals((await s.call(null, "POST", `/api/jobs/${id}`, { op: "decline" })).status, 403);
  // the phone: not a claim, not a report, not an accept without an assertion, not a proposal
  for (
    const b of [{ op: "claim" }, { op: "report", status: "done" }, { op: "accept", expires, signature: "x".repeat(86) }]
  ) {
    assertEquals((await s.call(null, "POST", `/api/jobs/${id}`, b, true)).status, 403);
  }
  assertEquals((await s.call(null, "POST", "/api/jobs", { kind: "routine", spec }, true)).status, 403);
  assertEquals(
    (await s.call(null, "POST", `/api/jobs/${id}`, { op: "accept", assertion: { credential: "x" }, expires }, true))
      .status,
    400,
  );
  const done = await s.call(null, "POST", `/api/jobs/${id}`, { op: "accept", assertion, expires }, true);
  assertEquals(done.status, 200);
  assertEquals(done.body.job.status, "accepted");
  assertEquals(done.body.job.assertion, assertion);
  assert(!("signature" in done.body.job));
  // the node gets it in its announce's reply, with the assertion
  const announced = (await s.call("srv", "PUT", "/api/node", { platform: "linux" })).body.jobs;
  assertEquals(announced[0].assertion, assertion);
  // and the phone can decline another
  const other = (await s.call("desk", "POST", "/api/jobs", { kind: "routine", node: "srv", spec })).body.job.id;
  assertEquals((await s.call(null, "POST", `/api/jobs/${other}`, { op: "decline" }, true)).body.job.status, "declined");
});
