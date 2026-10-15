// service.ts — this machine talking to the service (ADR 0012): outbound HTTPS with its own machine token (the
// one `agents brain-login` put in the vault), to the brain's address in accounts.json. Nothing here listens.

import { brainAccount } from "../../../shared/mcp/lib/brain-tasks.ts";
import { getSecret } from "../../../shared/mcp/lib/vault.ts";
import type { Announce, Job, NodeInfo } from "../../../shared/mcp/lib/nodes.ts";

export interface Service {
  url: string;
  call<T>(method: string, path: string, body?: unknown): Promise<T>;
}

/** The service as this machine reaches it, or why it cannot. */
export async function service(fetcher: typeof fetch = fetch): Promise<Service | string> {
  const account = brainAccount();
  if (!account?.url) return "no brain account with an address in accounts.json: the service is the brain";
  const token = await getSecret("brain", account.name).catch((e) => {
    throw new Error(`the vault: ${(e as Error).message}`);
  });
  if (!token) return `this machine has no token for ${account.url}: agents brain-login`;
  const base = account.url.replace(/\/+$/, "");
  return {
    url: base,
    async call<T>(method: string, path: string, body?: unknown): Promise<T> {
      const r = await fetcher(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const j = await r.json().catch(() => ({})) as Record<string, unknown>;
      if (!r.ok) throw new Error(`${method} ${path}: ${j.error ?? `HTTP ${r.status}`}`);
      return j as T;
    },
  };
}

export const announce = (s: Service, a: Announce) => s.call<{ jobs: Job[] }>("PUT", "/api/node", a);
export const fleet = (s: Service) => s.call<{ nodes: NodeInfo[]; jobs: Job[]; now: string }>("GET", "/api/nodes");
export const getJob = async (s: Service, id: string) => (await s.call<{ job: Job }>("GET", `/api/jobs/${id}`)).job;
export const newJob = async (s: Service, body: Record<string, unknown>) =>
  (await s.call<{ job: Job }>("POST", "/api/jobs", body)).job;
export const actOn = async (s: Service, id: string, body: Record<string, unknown>) =>
  (await s.call<{ job: Job }>("POST", `/api/jobs/${id}`, body)).job;
