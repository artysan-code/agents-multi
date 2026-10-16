// service.ts — this machine talking to the service (ADR 0012): outbound HTTPS to the brain's address in
// accounts.json. A node announces and takes jobs with its own token (`agents node login`), kept in a file of
// this machine only: the vault's brain token travels to every machine, and the service names a node after its
// token, so with it every machine would be the same node. Nothing here listens.

import { brainAccount } from "../../../shared/mcp/lib/brain-tasks.ts";
import { amEnv } from "../../../shared/mcp/lib/env.ts";
import { STATE } from "../lib/paths.ts";
import { getSecret } from "../../../shared/mcp/lib/vault.ts";
import type { Announce, Job, NodeInfo } from "../../../shared/mcp/lib/nodes.ts";
import type { PhoneAnswer } from "../../../shared/mcp/lib/webauthn.ts";
import type { Stop } from "./runs.ts";

/** A call the service refused: its HTTP status and the JSON it answered (`cancelled: true` on a turn stopped). */
export class ServiceError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

/** Whether an error is the service saying the turn was cancelled (409 with `cancelled: true`). */
export const isCancelled = (e: unknown): boolean =>
  e instanceof ServiceError && e.status === 409 && e.body.cancelled === true;

export interface Service {
  url: string;
  /** `timeout` in ms (15 s by default; a long poll asks for more), `signal` to give up when this machine stops */
  call<T>(method: string, path: string, body?: unknown, o?: { timeout?: number; signal?: AbortSignal }): Promise<T>;
  /** A GET whose body is read as it arrives (Server-Sent Events), with the same token; no overall timeout, `signal`
   *  ends it. Absent on the stand-ins of tests that never stream. */
  stream?(path: string, signal: AbortSignal): Promise<Response>;
  /** A GET of a file (a voice note's audio), with its type. Absent on the stand-ins of tests that fetch none. */
  bytes?(path: string, o?: { timeout?: number; signal?: AbortSignal }): Promise<{ type: string; data: Uint8Array }>;
}

/** Where this machine keeps its node token: a file only the user reads, never synced. */
export const nodeTokenFile = (): string => amEnv("NODE_TOKEN_FILE") ?? `${STATE}/node-token`;

export async function readNodeToken(): Promise<string | null> {
  return (await Deno.readTextFile(nodeTokenFile()).catch(() => "")).trim() || null;
}

export async function writeNodeToken(token: string): Promise<void> {
  const file = nodeTokenFile();
  await Deno.mkdir(file.replace(/\/[^/]+$/, ""), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(file, token + "\n", { mode: 0o600 });
  await Deno.chmod(file, 0o600);
}

/** The service as this machine reaches it, or why it cannot. `node`: as this node, with its own token only
 *  (agentd); otherwise its node token when it has one, else the vault's brain token (the owner's views). */
export async function service(
  fetcher: typeof fetch = fetch,
  { node = false }: { node?: boolean } = {},
): Promise<Service | string> {
  const account = brainAccount();
  if (!account?.url) return "no brain account with an address in accounts.json: the service is the brain";
  const own = await readNodeToken();
  if (node && !own) return "this machine has no node token of its own: agents node pair";
  const token = own ?? await getSecret("brain", account.name).catch((e) => {
    throw new Error(`the vault: ${(e as Error).message}`);
  });
  if (!token) return `this machine has no token for ${account.url}: agents brain-login`;
  const base = account.url.replace(/\/+$/, "");
  return {
    url: base,
    async call<T>(
      method: string,
      path: string,
      body?: unknown,
      o: { timeout?: number; signal?: AbortSignal } = {},
    ): Promise<T> {
      const r = await fetcher(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: o.signal
          ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeout ?? 15_000)])
          : AbortSignal.timeout(o.timeout ?? 15_000),
      });
      const j = await r.json().catch(() => ({})) as Record<string, unknown>;
      if (!r.ok) throw new ServiceError(`${method} ${path}: ${j.error ?? `HTTP ${r.status}`}`, r.status, j);
      return j as unknown as T;
    },
    async bytes(path: string, o: { timeout?: number; signal?: AbortSignal } = {}) {
      const r = await fetcher(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: o.signal
          ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeout ?? 60_000)])
          : AbortSignal.timeout(o.timeout ?? 60_000),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({})) as Record<string, unknown>;
        throw new ServiceError(`GET ${path}: ${j.error ?? `HTTP ${r.status}`}`, r.status, j);
      }
      return { type: r.headers.get("content-type") ?? "", data: new Uint8Array(await r.arrayBuffer()) };
    },
    stream: (path: string, signal: AbortSignal) =>
      fetcher(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" }, signal }),
  };
}

export const announce = (s: Service, a: Announce) =>
  s.call<{ jobs: Job[]; answers?: PhoneAnswer[]; declined?: Job[]; stops?: Stop[] }>("PUT", "/api/node", a);
export const fleet = (s: Service) => s.call<{ nodes: NodeInfo[]; jobs: Job[]; now: string }>("GET", "/api/nodes");
export const getJob = async (s: Service, id: string) => (await s.call<{ job: Job }>("GET", `/api/jobs/${id}`)).job;
export const newJob = async (s: Service, body: Record<string, unknown>) =>
  (await s.call<{ job: Job }>("POST", "/api/jobs", body)).job;
export const actOn = async (s: Service, id: string, body: Record<string, unknown>) =>
  (await s.call<{ job: Job }>("POST", `/api/jobs/${id}`, body)).job;
