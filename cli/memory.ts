// memory.ts — the brain as the console's Brain page reads it: pages, one page with its links and
// versions, search, health, from the brain service (brain/api.ts) with this machine's personal
// token from the vault. The browser asks the console, the console asks the brain: the token never
// reaches the page. Only reads; changes go through Claude, where the rules answer.

import { brainAccount } from "../shared/mcp/lib/brain-tasks.ts";
import { getSecret } from "../shared/mcp/lib/vault.ts";

/** The console's paths and the brain's: nothing else passes, and only these query parameters. */
const ROUTES: Record<string, string> = {
  "/api/brain/pages": "/api/brain/pages",
  "/api/brain/page": "/api/brain/page",
  "/api/brain/search": "/api/brain/search",
  "/api/brain/health": "/api/brain/health",
};
const PARAMS = ["path", "rev", "q", "limit"];

/** Pure: the brain's address for a console request, or null when it is not one of the reads. */
export function upstream(base: string, u: URL): string | null {
  const to = ROUTES[u.pathname];
  if (!to) return null;
  const q = new URLSearchParams();
  for (const k of PARAMS) {
    const v = u.searchParams.get(k);
    if (v !== null) q.set(k, v);
  }
  return `${base.replace(/\/+$/, "")}${to}${q.size ? `?${q}` : ""}`;
}

/** Where the brain is and the token to read it, or why there is none. */
async function target(): Promise<{ url: string; token: string } | { error: string }> {
  const account = brainAccount(undefined);
  if (!account?.url) return { error: "no brain account in accounts.json" };
  const token = await getSecret("brain", account.name).catch(() => null);
  if (!token) {
    return {
      error: `no token for the brain on this machine: make one on ${account.url}/account and put it in Connections`,
    };
  }
  return { url: account.url, token };
}

async function call(url: string, token: string, fetcher: typeof fetch): Promise<Response> {
  try {
    return await fetcher(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return new Response(JSON.stringify({ error: `the brain is not answering (${(e as Error).message})` }), {
      status: 502,
    });
  }
}

/** A GET under /api/brain/ answered from the brain, or null when the path is not one of these. */
export async function memoryApi(u: URL, fetcher: typeof fetch = fetch): Promise<Response | null> {
  if (!ROUTES[u.pathname]) return null;
  const tg = await target();
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  if ("error" in tg) return new Response(JSON.stringify({ error: tg.error }), { status: 503, headers });
  const r = await call(upstream(tg.url, u)!, tg.token, fetcher);
  if (r.status === 401) {
    await r.body?.cancel();
    return new Response(
      JSON.stringify({
        error:
          "the brain refused the token in the vault: make a new one on its /account page and put it in Connections",
      }),
      { status: 502, headers },
    );
  }
  return new Response(r.body, { status: r.status, headers });
}

/** What the memory is at (a version that changes with every page write), or null when unknown. */
export async function memoryVersion(fetcher: typeof fetch = fetch): Promise<string | null> {
  const tg = await target();
  if ("error" in tg) return null;
  const r = await call(`${tg.url.replace(/\/+$/, "")}/api/brain/state`, tg.token, fetcher);
  if (!r.ok) {
    await r.body?.cancel();
    return null;
  }
  return ((await r.json()) as { version?: string }).version ?? null;
}
