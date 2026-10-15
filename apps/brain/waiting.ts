// waiting.ts — what waits on an account's machines, and the phone's yes (ADR 0014, G5): the requests and
// questions a node relays, the passkeys the phone registers, and the answers it sends back. The service only
// carries them: it parses a registration to keep the public key, and it stores an endorsement and an answer's
// assertion without trusting either — the node verifies the endorsement with the owner's key and the assertion
// with the passkey's, and only then answers its hub (apps/cli/node/waiting.ts, shared/mcp/lib/webauthn.ts).

import type { DatabaseSync } from "node:sqlite";
import { validNodeName } from "../../shared/mcp/lib/nodes.ts";
import {
  b64u,
  boundWords,
  cleanAssertion,
  clientChallenge,
  MAX_AHEAD_MS,
  parseRegistration,
  type Site,
} from "../../shared/mcp/lib/webauthn.ts";

export class WaitingError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** A node that has not said what waits on it for this long is not shown as waiting. */
const STALE_MS = 10 * 60_000;
// a little over the browser's own timeout for the ceremony (below), so the last seconds of it still count
const CHALLENGE_MS = 6 * 60_000;
const MAX_PASSKEYS = 20;
const MAX_REQUESTS = 200;
const ANSWER_KEEP_MS = 24 * 3600_000;

/** a child's id and a request's id: what a request's path is made of */
const SEGMENT = /^[\w.:-]{1,100}$/;
const str = (v: unknown, n: number) => typeof v === "string" ? v.slice(0, n) : "";

/** Pure: a request a node relayed as the service keeps it: known fields only, text bounded, junk dropped. */
export function cleanRequest(raw: unknown): Record<string, unknown> | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = str(r.id, 200), child = str(r.child, 100), request = str(r.request, 100);
  if (!SEGMENT.test(child) || !SEGMENT.test(request) || id !== `${child}/${request}`) return null;
  if (r.kind !== "request" && r.kind !== "question") return null;
  // kept exactly as the node relayed them (it bounded them the same way): the phone hashes what it is shown and
  // the node checks that hash against its own hub's copy, so nothing here may rephrase them
  const w = boundWords(r.what, r.questions);
  return {
    id,
    child,
    request,
    profile: str(r.profile, 60),
    project: str(r.project, 300),
    kind: r.kind,
    what: w.what,
    ...(w.questions ? { questions: w.questions } : {}),
  };
}

export class Waiting {
  constructor(
    private db: DatabaseSync,
    private site: Site,
    private now = () => Date.now(),
    private newChallenge: () => string = () => b64u(crypto.getRandomValues(new Uint8Array(32))),
  ) {}

  private iso = () => new Date(this.now()).toISOString();

  // ------------------------------------------------------------ what waits

  /** Replaces what waits on a node with what it says now. */
  setRequests(node: string, raw: unknown): number {
    if (!Array.isArray(raw)) throw new WaitingError("requests is a list");
    const rows = raw.slice(0, MAX_REQUESTS).map(cleanRequest).filter((r): r is Record<string, unknown> => !!r);
    const at = this.iso();
    this.db.exec("begin immediate");
    try {
      this.db.prepare("delete from waiting where node = ?").run(node);
      const put = this.db.prepare("insert or replace into waiting (node, id, data, updated) values (?, ?, ?, ?)");
      for (const r of rows) put.run(node, r.id as string, JSON.stringify(r), at);
      this.db.exec("commit");
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
    return rows.length;
  }

  /** What waits now, on the nodes that said so lately. */
  requests(): Record<string, unknown>[] {
    const since = new Date(this.now() - STALE_MS).toISOString();
    return (this.db.prepare("select node, data from waiting where updated >= ? order by node, id").all(since) as {
      node: string;
      data: string;
    }[]).map((r) => ({ ...JSON.parse(r.data), node: r.node }));
  }

  // ------------------------------------------------------------ passkeys

  /** The options for the phone to make a passkey, with a challenge kept here until it is used. */
  creationOptions(user: string): Record<string, unknown> {
    const now = this.now();
    this.db.prepare("delete from passkey_challenges where expires < ?").run(now);
    const live = (this.db.prepare("select count(*) as n from passkey_challenges").get() as { n: number }).n;
    if (live >= 20) throw new WaitingError("too many registrations started: wait a few minutes", 429);
    const challenge = this.newChallenge();
    this.db.prepare("insert into passkey_challenges (challenge, expires) values (?, ?)").run(
      challenge,
      now + CHALLENGE_MS,
    );
    return {
      rp: { id: this.site.rpId, name: "Agents Multi" },
      user: { id: b64u(new TextEncoder().encode(user)), name: user, displayName: user },
      challenge,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      timeout: 300_000,
      attestation: "none",
      // a discoverable credential, which password managers and the platform keep and offer again
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      excludeCredentials: this.passkeys().map((p) => ({ type: "public-key", id: p.id })),
    };
  }

  /** A registration from the phone: parsed, its public key kept, pending until a desktop endorses it. */
  async register(raw: Record<string, unknown>): Promise<{ id: string; state: "pending" }> {
    const name = str(raw.name, 60).trim() || "Phone";
    const cred = raw.credential as { id?: string; response?: { attestationObject?: string; clientDataJSON?: string } };
    const cd = cred?.response?.clientDataJSON, ao = cred?.response?.attestationObject;
    if (typeof cd !== "string" || typeof ao !== "string") throw new WaitingError("no credential");
    const challenge = clientChallenge(cd);
    // a challenge is used once, whatever comes of it
    const mine = challenge
      ? this.db.prepare("delete from passkey_challenges where challenge = ? and expires >= ? returning challenge").get(
        challenge,
        this.now(),
      )
      : undefined;
    if (!mine) throw new WaitingError("start again: the challenge is unknown or expired");
    const r = await parseRegistration(
      {
        ...(typeof cred.id === "string" ? { id: cred.id } : {}),
        response: { attestationObject: ao, clientDataJSON: cd },
      },
      challenge!,
      this.site,
    );
    if ("error" in r) throw new WaitingError(r.error);
    if (this.passkeys().length >= MAX_PASSKEYS) throw new WaitingError("too many passkeys: revoke one", 409);
    try {
      this.db.prepare("insert into passkeys (id, name, public_key, endorsement, created) values (?, ?, ?, null, ?)")
        .run(
          r.id,
          name,
          r.publicKey,
          this.iso(),
        );
    } catch {
      throw new WaitingError("this passkey is already registered", 409);
    }
    return { id: r.id, state: "pending" };
  }

  passkeys(): { id: string; name: string; publicKey: string; endorsement: string | null; created: string }[] {
    return (this.db.prepare("select id, name, public_key, endorsement, created from passkeys order by created")
      .all() as {
        id: string;
        name: string;
        public_key: string;
        endorsement: string | null;
        created: string;
      }[]).map((r) => ({
        id: r.id,
        name: r.name,
        publicKey: r.public_key,
        endorsement: r.endorsement,
        created: r.created,
      }));
  }

  /** The owner's signature on a passkey, kept as it came: the nodes check it, the service cannot. */
  endorse(id: string, raw: Record<string, unknown>): void {
    const sig = raw.signature;
    if (typeof sig !== "string" || !/^[\w-]{80,100}$/.test(sig)) throw new WaitingError("no signature");
    const r = this.db.prepare("update passkeys set endorsement = ? where id = ?").run(sig, id);
    if (!r.changes) throw new WaitingError("no such passkey", 404);
  }

  revoke(id: string): boolean {
    return this.db.prepare("delete from passkeys where id = ?").run(id).changes > 0;
  }

  // ------------------------------------------------------------ the phone's answer

  /** An answer from the phone, kept for the node to check: never decided here. */
  answer(id: string, raw: Record<string, unknown>): { id: string; state: "pending" } {
    const now = this.now();
    const wanted = typeof raw.node === "string" ? raw.node : null;
    const rows = this.db.prepare("select node from waiting where id = ? order by updated desc").all(id) as {
      node: string;
    }[];
    const row = wanted ? rows.find((r) => r.node === wanted) : rows[0];
    if (!row) throw new WaitingError("nothing waits on that any more", 404);
    const verdict = raw.verdict;
    if (verdict !== "allow" && verdict !== "session" && verdict !== "deny") {
      throw new WaitingError("verdict is allow, session or deny");
    }
    let answers: string | null = null;
    if (raw.answers !== undefined) {
      const a = raw.answers as Record<string, unknown>;
      if (!a || typeof a !== "object" || Array.isArray(a) || Object.values(a).some((v) => typeof v !== "string")) {
        throw new WaitingError("answers are text by question");
      }
      answers = JSON.stringify(a);
      if (answers.length > 8000) throw new WaitingError("answers are too long");
    }
    const until = typeof raw.expires === "string" ? Date.parse(raw.expires) : NaN;
    if (!(until > now && until <= now + MAX_AHEAD_MS + 60_000)) throw new WaitingError("expires is within ten minutes");
    const asm = cleanAssertion(raw.assertion);
    if (!asm) throw new WaitingError("the assertion lacks a part");
    if (!this.passkeys().some((p) => p.id === asm.credential)) throw new WaitingError("not a passkey of this account");
    const open = this.db.prepare(
      "select 1 from waiting_answers where id = ? and node = ? and state = 'pending' and expires >= ?",
    ).get(id, row.node, new Date(now).toISOString());
    if (open) throw new WaitingError("already answered: the machine has not picked it up yet", 409);
    this.db.prepare(
      "insert into waiting_answers (id, node, verdict, answers, expires, assertion, created) values (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      row.node,
      verdict,
      answers,
      new Date(until).toISOString(),
      JSON.stringify(asm),
      new Date(now).toISOString(),
    );
    return { id, state: "pending" };
  }

  /** The answers waiting for a node, as it checks them. */
  pending(node: string): Record<string, unknown>[] {
    const at = this.iso();
    this.db.prepare("delete from waiting_answers where created < ?").run(
      new Date(this.now() - ANSWER_KEEP_MS).toISOString(),
    );
    // what lapsed before the node came for it is refused here, so that the phone sees it
    this.db.prepare(
      "update waiting_answers set state = 'refused', why = 'it expired before the machine picked it up' where state = 'pending' and expires < ?",
    ).run(at);
    return (this.db.prepare(
      "select id, node, verdict, answers, expires, assertion, created from waiting_answers where node = ? and state = 'pending' order by seq",
    ).all(node) as {
      id: string;
      node: string;
      verdict: string;
      answers: string | null;
      expires: string;
      assertion: string;
      created: string;
    }[]).map((r) => ({
      id: r.id,
      node: r.node,
      verdict: r.verdict,
      ...(r.answers ? { answers: JSON.parse(r.answers) } : {}),
      expires: r.expires,
      assertion: JSON.parse(r.assertion),
      created: r.created,
    }));
  }

  /** What a node did with the answers it was given: applied, or refused with why. */
  report(node: string, raw: unknown): number {
    if (!Array.isArray(raw)) throw new WaitingError("results is a list");
    let n = 0;
    const set = this.db.prepare(
      "update waiting_answers set state = ?, why = ? where node = ? and id = ? and state = 'pending'",
    );
    for (const r of raw.slice(0, 100)) {
      const x = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      if (typeof x.id !== "string") continue;
      n += Number(
        set.run(x.ok === true ? "applied" : "refused", x.ok === true ? null : str(x.why, 300) || "refused", node, x.id)
          .changes,
      );
    }
    return n;
  }

  /** The answers of the last hour and how they ended, for the phone to say so. */
  recent(): Record<string, unknown>[] {
    const since = new Date(this.now() - 3600_000).toISOString();
    return (this.db.prepare(
      "select id, node, verdict, state, why, created from waiting_answers where created >= ? order by seq desc limit 50",
    ).all(since) as Record<string, unknown>[]);
  }
}

/** The routes, for a caller signed in to the account. `node`: the machine whose token it is (null for a web
 *  session). `jobs`: the proposed jobs. Null when the path is not theirs. */
export async function waitingRoute(
  req: Request,
  u: URL,
  node: string | null,
  w: Waiting,
  proposedJobs: () => unknown[],
  user: string,
): Promise<Response | null> {
  const p = u.pathname, m = req.method;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  const body = async () => {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw new WaitingError("a JSON object is expected");
    return b as Record<string, unknown>;
  };
  const machine = () => {
    if (!node || !validNodeName(node)) throw new WaitingError("only a machine's own token does this", 403);
    return node;
  };
  try {
    if (p === "/api/node/requests" && m === "PUT") {
      return json({ ok: true, n: w.setRequests(machine(), (await body()).requests) });
    }
    if (p === "/api/node/answers" && m === "GET") return json({ answers: w.pending(machine()) });
    if (p === "/api/node/answers" && m === "POST") {
      return json({ ok: true, n: w.report(machine(), (await body()).results) });
    }
    if (p === "/api/waiting" && m === "GET") {
      return json({ requests: w.requests(), jobs: proposedJobs(), answers: w.recent() });
    }
    if (p.startsWith("/api/waiting/") && m === "POST") {
      let id: string;
      try {
        id = decodeURIComponent(p.slice("/api/waiting/".length));
      } catch {
        throw new WaitingError("not a request id");
      }
      if (!/^[\w.:-]{1,100}\/[\w.:-]{1,100}$/.test(id)) throw new WaitingError("not a request id");
      return json(w.answer(id, await body()));
    }
    if (p === "/api/passkeys/options" && m === "POST") return json(w.creationOptions(user));
    if (p === "/api/passkeys" && m === "POST") return json(await w.register(await body()));
    if (p === "/api/passkeys" && m === "GET") return json(w.passkeys());
    const one = p.match(/^\/api\/passkeys\/([\w-]{1,1400})(\/endorse)?$/);
    if (one && one[2] && m === "POST") {
      // the owner's signature comes from a machine of theirs with a token; a web session never endorses
      machine();
      w.endorse(one[1], await body());
      return json({ ok: true });
    }
    if (one && !one[2] && m === "DELETE") {
      return w.revoke(one[1]) ? json({ ok: true }) : json({ error: "no such passkey" }, 404);
    }
  } catch (e) {
    if (e instanceof WaitingError) return json({ error: e.message }, e.status);
    throw e;
  }
  return null;
}
