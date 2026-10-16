// nodes.ts — what the machines and the service share about nodes and jobs (ADR 0012): the shape of an
// announcement and of a job, the owner's signature on a job and its check on the node, the session cap, where
// a job is best placed, and what a silent node's jobs become. Pure but for WebCrypto; no other import, so the
// service's image (apps/brain/Dockerfile) carries it alone.

// ---------------------------------------------------------------- shapes

/** What a node says about itself every 30 s (`PUT /api/node`). Its name is the service's, from its token. */
export interface Announce {
  platform: string;
  /** the version of Agents Multi it runs */
  version: string;
  headless: boolean;
  /** one-minute load average */
  load: number;
  /** bytes: the container's limit where there is one, else the machine's; and what is free */
  memTotal: number;
  memFree: number;
  /** sessions it may run at once, and how many run now */
  cap: number;
  running: number;
  /** the accounts it can run, `<profile>/<provider>` */
  accounts: string[];
  /** the owner is at it: a graphical session that is not locked (never on a server) */
  present: boolean;
  /** the Bash sandbox works here (null: not probed, a desktop that does not need it) */
  sandbox: boolean | null;
  /** it can transcribe a voice note (whisper.cpp and ffmpeg here): the only kind of node that takes a voice turn */
  voice?: boolean;
  /** a server's git key, public half (ADR 0013, F2): the owner adds it to the forge from the console's page */
  gitKey?: string;
  /** what a server's setup still waits for (a Claude token missing, the forge refusing its key), one line each */
  waits?: string[];
  /** set by the service, never announced: `server` for a node paired as one (its token's scope is `node`) */
  kind?: "server";
}

export interface NodeInfo extends Announce {
  name: string;
  /** when it last announced (ISO) */
  seen: string;
}

/** What a job does. `routine`: a routine's action, now, on that node. `resume`: carry on run `id`, whose branch
 *  is `agent/<id>` and whose HANDOFFs are on `refs/agents/<id>`. Folders are relative to the repository, which
 *  each node finds by its remote. */
export interface JobSpec {
  name: string;
  /** the repository's remote, as `normalRemote` writes it */
  repo: string;
  /** the folder inside the repository ("" is its root) */
  path: string;
  /** the routine's action, as routines.ts keeps it (a child or a workflow) */
  action: { kind: string; [k: string]: unknown };
  /** the account it runs on, `<profile>/<provider>` */
  account?: string;
  /** resume: the run it continues, and the node it ran on */
  id?: string;
  from?: string;
}

export type JobKind = "routine" | "resume";
export type JobStatus =
  | "proposed"
  | "accepted"
  | "declined"
  | "lapsed"
  | "running"
  | "done"
  | "failed"
  | "interrupted";

/** A passkey's answer (WebAuthn, ADR 0014): the parts of an assertion, base64url; `credential` is the passkey's id. */
export interface PasskeyAssertion {
  credential: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export interface Job {
  id: string;
  /** the node it is for ("" while a proposal found nowhere to go) */
  node: string;
  kind: JobKind;
  spec: JobSpec;
  status: JobStatus;
  /** why it was proposed, or what happened */
  reason?: string;
  /** a node's own routine firing, recorded so it can be seen and resumed: never signed */
  local?: boolean;
  /** base64url Ed25519 over `signedText`, and until when it holds */
  signature?: string;
  /** or, from the phone, an endorsed passkey's assertion over the same text (webauthn.ts), and until when */
  assertion?: PasskeyAssertion;
  expires?: string;
  created: string;
  updated: string;
  /** who raised it: a node's name, or "service" */
  by: string;
  /** the last commit pushed, for a running job */
  head?: string;
  /** the job it resumes */
  parent?: string;
}

/** A node seen within this is online; a node unseen for `STALE_MS` loses its running jobs. */
export const ONLINE_MS = 90_000;
export const STALE_MS = 10 * 60_000;
/** an accepted job, and a pending proposal, hold this long */
export const JOB_TTL_MS = 24 * 3600_000;
/** what a session is counted to need, and what the machine keeps for itself */
export const SESSION_BYTES = 1.5 * 2 ** 30;
export const RESERVED_BYTES = 2 * 2 ** 30;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export const validNodeName = (s: unknown): s is string => typeof s === "string" && NAME.test(s);
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** Pure: a node's name from its machine token's (`agents brain-login` names it `agents-multi su <hostname>`):
 *  the hostname, with anything outside letters, digits, `.`, `_` and `-` made a `-`. The node computes the same
 *  from its own hostname, so it never takes its name from the service. */
export function nodeNameOf(tokenName: string): string {
  const s = tokenName.trim().replace(/^agents-multi su /, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+/, "");
  return s.slice(0, 63) || "node";
}

// ---------------------------------------------------------------- what a node can take

/** Pure: the memory a node counts with: the cgroup's limit (`memory.max`, "max" when none) when it is set
 *  and below the machine's, else the machine's. */
export function memoryLimit(cgroupMax: string | null, total: number): number {
  const n = Number(cgroupMax?.trim());
  return Number.isFinite(n) && n > 0 && n < total ? n : total;
}

/** Pure: how many sessions a node runs at once: its override, else what its memory holds after what the
 *  machine keeps, at least one. */
export function sessionCap(mem: number, override?: unknown): number {
  if (typeof override === "number" && Number.isInteger(override) && override >= 0) return override;
  return Math.max(1, Math.floor((mem - RESERVED_BYTES) / SESSION_BYTES));
}

/** Pure: whether the owner is at the machine, from `loginctl show-session -p Type -p Active -p LockedHint`
 *  of each session: a graphical one (x11, wayland) that is active and not locked. */
export function presentFrom(sessions: string[]): boolean {
  return sessions.some((s) => {
    const v = (k: string) => s.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim();
    return ["x11", "wayland"].includes(v("Type") ?? "") && v("Active") === "yes" && v("LockedHint") !== "yes";
  });
}

/** Pure: a remote as nodes compare it: no credentials, no `.git`, no trailing slash, `scp`-like and ssh URLs
 *  alike (`git@host:a/b` and `ssh://git@host/a/b` are `host/a/b`); the port of an ssh URL stays. */
export function normalRemote(url: string): string {
  let u = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const scp = u.match(/^[\w.-]+@([\w.-]+):(?!\/)(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  u = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]*@/, "");
  return u.toLowerCase();
}

/** Pure: whether a node is online, and whether it has been gone long enough to lose its jobs. */
export const isOnline = (n: Pick<NodeInfo, "seen">, now: number) => now - Date.parse(n.seen) < ONLINE_MS;
export const isStale = (n: Pick<NodeInfo, "seen">, now: number) => now - Date.parse(n.seen) >= STALE_MS;

/** Pure: why a node cannot take a job now, or null when it can. */
export function cannotTake(n: NodeInfo, spec: { account?: string }, now: number): string | null {
  if (!isOnline(n, now)) return "offline";
  if (n.headless && n.sandbox !== true) return "its sandbox does not work";
  if (n.running >= n.cap) return `full (${n.running}/${n.cap} sessions)`;
  if (spec.account && !n.accounts.includes(spec.account)) return `no ${spec.account} login`;
  return null;
}

/** Pure: the best node for a job, never `not`: one that can take it; then, with the owner away, a server;
 *  then the most room. Null when none can. */
export function place(spec: { account?: string }, nodes: NodeInfo[], now: number, not?: string): string | null {
  const ok = nodes.filter((n) => n.name !== not && cannotTake(n, spec, now) === null);
  const away = !nodes.some((n) => n.present && isOnline(n, now));
  ok.sort((a, b) =>
    (away ? Number(b.headless) - Number(a.headless) : 0) || (b.cap - b.running) - (a.cap - a.running) ||
    a.name.localeCompare(b.name)
  );
  return ok[0]?.name ?? null;
}

/** Pure: what time does to the jobs: the running ones of a node gone for `STALE_MS` are interrupted, and each
 *  gets a proposal to resume elsewhere (a run id is needed to resume; a job without one is only marked); a
 *  proposal or an accepted job past its time lapses. Returns the changes to make. */
export function sweep(
  nodes: NodeInfo[],
  jobs: Job[],
  now: number,
): { interrupted: string[]; lapsed: string[]; resume: { parent: Job; node: string }[] } {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const interrupted: string[] = [], lapsed: string[] = [], resume: { parent: Job; node: string }[] = [];
  const resumed = new Set(jobs.map((j) => j.parent).filter(Boolean));
  for (const j of jobs) {
    if (j.status === "running") {
      const n = byName.get(j.node);
      if (n && !isStale(n, now)) continue;
      interrupted.push(j.id);
      if (j.spec.id && !resumed.has(j.id)) resume.push({ parent: j, node: place(j.spec, nodes, now, j.node) ?? "" });
    } else if (j.status === "proposed" && now - Date.parse(j.created) > JOB_TTL_MS) lapsed.push(j.id);
    else if (j.status === "accepted" && j.expires && now > Date.parse(j.expires)) lapsed.push(j.id);
  }
  return { interrupted, lapsed, resume };
}

/** Pure: the proposal that resumes an interrupted job. */
export function resumeOf(parent: Job, node: string, id: string, now: Date): Job {
  const at = now.toISOString();
  return {
    id,
    node,
    kind: "resume",
    spec: { ...parent.spec, from: parent.node },
    status: "proposed",
    reason: `${parent.node} went silent while it ran ${parent.spec.name}`,
    created: at,
    updated: at,
    by: "service",
    parent: parent.id,
  };
}

/** Pure: what is wrong with a spec a node sent, nothing when it can be kept. */
export function specErrors(s: unknown): string[] {
  const x = (s ?? {}) as Partial<JobSpec>;
  const e: string[] = [];
  if (typeof x.name !== "string" || !x.name.trim()) e.push("name");
  if (typeof x.repo !== "string" || !x.repo) e.push("repo");
  if (typeof x.path !== "string" || x.path.startsWith("/") || x.path.split("/").includes("..")) e.push("path");
  if (!x.action || typeof x.action !== "object" || typeof x.action.kind !== "string") e.push("action");
  if (x.id !== undefined && (typeof x.id !== "string" || !RUN_ID.test(x.id))) e.push("id");
  if (x.account !== undefined && typeof x.account !== "string") e.push("account");
  return e;
}

// ---------------------------------------------------------------- the owner's signature

/** Pure: JSON with the keys of every object in order, so that both sides sign and check the same bytes. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${
      Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
        .join(",")
    }}`;
  }
  return JSON.stringify(v);
}

/** Pure: the bytes the owner signs for a job. */
export function signedText(j: Pick<Job, "id" | "node" | "kind" | "spec" | "expires">): string {
  return `agents-multi job v1\n${
    canonical({ id: j.id, node: j.node, kind: j.kind, spec: j.spec, expires: j.expires })
  }`;
}

const enc = new TextEncoder();
const b64u = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unb64u = (s: string) =>
  Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
// PKCS#8 for an Ed25519 private key is this header and the 32-byte seed (RFC 8410)
const PKCS8_HEAD = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

export interface ApprovalKeys {
  sign: CryptoKey;
  /** the public key, base64url: what a node without a vault pins (`approvalKey` in node.json) */
  public: string;
}

/** Where a server's vault holds the owner's public approval key (ADR 0015): the key is derived from the owner's vault
 *  key, which a server does not have, so the owner's machine puts the public half there. */
export const APPROVAL_ENTRY = { service: "approval", account: "owner", field: "public" } as const;

/** The owner's approval keys, derived from the vault key (HKDF-SHA256 with a label of their own): any machine
 *  with the vault signs, the service never can. */
export async function approvalKeys(vaultRaw: Uint8Array): Promise<ApprovalKeys> {
  const base = await crypto.subtle.importKey("raw", vaultRaw as BufferSource, "HKDF", false, ["deriveBits"]);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode("agents-multi approval v1") },
      base,
      256,
    ),
  );
  const sign = await crypto.subtle.importKey("pkcs8", new Uint8Array([...PKCS8_HEAD, ...seed]), "Ed25519", true, [
    "sign",
  ]);
  const { x } = await crypto.subtle.exportKey("jwk", sign);
  return { sign, public: x! };
}

/** The signature of a job, base64url. */
export async function signJob(j: Parameters<typeof signedText>[0], key: CryptoKey): Promise<string> {
  return b64u(new Uint8Array(await crypto.subtle.sign("Ed25519", key, enc.encode(signedText(j)))));
}

/** Why a node must not run a job, or null when the owner's yes holds: signed with the owner's key, or approved
 *  by an endorsed passkey (`viaPasskey` checks that, webauthn.ts), for this node, not expired, not run before. A
 *  local job is never taken from the service. */
export async function verifyJob(
  j: Job,
  publicKey: string,
  self: string,
  now: number,
  seen: Iterable<string>,
  viaPasskey?: (j: Job) => Promise<string | null>,
): Promise<string | null> {
  if (j.local) return "a local job is not taken from the service";
  if (j.node !== self) return `it is for ${j.node || "no node"}, not ${self}`;
  if ((!j.signature && !j.assertion) || !j.expires) return "not signed";
  if (!(now < Date.parse(j.expires))) return "its approval expired";
  if ([...seen].includes(j.id)) return "already run here";
  if (!j.signature) return viaPasskey ? await viaPasskey(j) : "approved by a passkey, which this node cannot check";
  try {
    const pub = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: publicKey }, "Ed25519", false, [
      "verify",
    ]);
    const ok = await crypto.subtle.verify("Ed25519", pub, unb64u(j.signature), enc.encode(signedText(j)));
    return ok ? null : "the signature is not the owner's";
  } catch {
    return "the signature is not the owner's";
  }
}
