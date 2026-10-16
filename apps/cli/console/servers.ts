// servers.ts — Connections › Add a server (ADR 0013, F2): the console's side of pairing a server node from its code.
// The page sends the code; the service answers which server asks and its key's fingerprint, which the owner
// compares with the one in the container's log. On their yes the console asks again, checks the key is still the
// one they compared, seals the vault key to it here (seal.ts: the browser never has the key, the service never
// has it open) and confirms with the box. Afterwards the page follows the server's row: online, its git key's
// public half to add to the forge, and what its setup still waits for.

import { loadKey } from "../../../shared/mcp/lib/vault.ts";
import { keyFingerprint, sealTo } from "../../../shared/mcp/lib/seal.ts";
import type { NodeInfo } from "../../../shared/mcp/lib/nodes.ts";
import { type Service, service } from "../node/service.ts";
import { json, type Route } from "./http.ts";

/** What the service's preview of a server's pairing says (apps/brain/pair.ts `Preview`). */
interface Preview {
  node: string;
  platform: string;
  asked: string;
  kind?: "server";
  key?: string;
  publicKey?: string;
  id?: string;
}

export type ServerOp<T> = ({ ok: true } & T) | { ok: false; message: string };

export interface ServerDeps {
  svc: () => Promise<Service | string>;
  /** the vault key's 32 bytes, from this machine's keyring (or key file) */
  vaultKey: () => Promise<Uint8Array>;
}

const realDeps: ServerDeps = {
  svc: () => service().catch((e: Error) => e.message),
  vaultKey: async () => (await loadKey()).raw,
};

const failed = (e: unknown) => ({ ok: false as const, message: (e as Error).message.replace(/^POST \S+: /, "") });

async function previewOf(s: Service, code: string): Promise<Preview> {
  const r = await s.call<{ preview?: Preview }>("POST", "/api/pair/claim", { code });
  if (!r.preview) throw new Error("the service did not show which machine asks");
  return r.preview;
}

/** The code typed: which server asks, and its key's fingerprint. Nothing is bound yet. */
export async function claimServer(
  code: string,
  deps: ServerDeps = realDeps,
): Promise<ServerOp<{ node: string; platform: string; asked: string; fingerprint: string }>> {
  const s = await deps.svc();
  if (typeof s === "string") return { ok: false, message: s };
  try {
    const p = await previewOf(s, code);
    if (p.kind !== "server" || !p.publicKey) {
      return { ok: false, message: "this code is a desktop's: pair it from the web app's Machines page" };
    }
    // the fingerprint of the key the vault would be sealed to, computed here: the service's `key` is not trusted
    return {
      ok: true,
      node: p.node,
      platform: p.platform,
      asked: p.asked,
      fingerprint: await keyFingerprint(p.publicKey),
    };
  } catch (e) {
    return failed(e);
  }
}

/** The owner's yes, for the fingerprint they compared: the vault key sealed to that key and the pairing confirmed.
 *  A key that changed since (another fingerprint) is refused and nothing is sealed. `vault: false` pairs it without
 *  the vault key (a server that has it already). */
export async function confirmServer(
  code: string,
  fingerprint: string,
  vault = true,
  deps: ServerDeps = realDeps,
): Promise<ServerOp<{ node: string; sealed: boolean }>> {
  const s = await deps.svc();
  if (typeof s === "string") return { ok: false, message: s };
  try {
    const p = await previewOf(s, code);
    if (p.kind !== "server" || !p.publicKey || !p.id) return { ok: false, message: "this code is not a server's" };
    if (!fingerprint || await keyFingerprint(p.publicKey) !== fingerprint) {
      return { ok: false, message: "the server's key is not the one you compared: nothing was sent" };
    }
    const sealed = vault ? await sealTo(await deps.vaultKey(), p.publicKey, p.id) : undefined;
    const r = await s.call<{ node: string }>("POST", "/api/pair/claim", {
      code,
      confirm: true,
      scope: "node",
      ...(sealed ? { sealed } : {}),
    });
    return { ok: true, node: r.node, sealed: !!sealed };
  } catch (e) {
    return failed(e);
  }
}

/** Pure: what the page shows of a server once paired: online or not, its git key, what waits. */
export function serverView(nodes: NodeInfo[], name: string, now: number) {
  const n = nodes.find((x) => x.name === name);
  if (!n) return { known: false as const };
  return {
    known: true as const,
    online: now - Date.parse(n.seen) < 90_000,
    seen: n.seen,
    server: n.kind === "server",
    gitKey: n.gitKey ?? null,
    waits: n.waits ?? [],
    accounts: n.accounts,
    sandbox: n.sandbox,
  };
}

/** The server's row as the service sees it, by name. */
export async function serverState(name: string, deps: ServerDeps = realDeps) {
  const s = await deps.svc();
  if (typeof s === "string") return { ok: false as const, message: s };
  try {
    const f = await s.call<{ nodes: NodeInfo[]; now: string }>("GET", "/api/nodes");
    return { ok: true as const, ...serverView(f.nodes, name, Date.parse(f.now) || Date.now()) };
  } catch (e) {
    return failed(e);
  }
}

/** The console's routes for the page. */
export function serverRoutes(): Record<string, Route> {
  const body = async (req: Request) => await req.json().catch(() => ({})) as Record<string, unknown>;
  return {
    "/api/servers/claim": { post: async ({ req }) => json(await claimServer(String((await body(req)).code ?? ""))) },
    "/api/servers/confirm": {
      post: async ({ req }) => {
        const b = await body(req);
        return json(await confirmServer(String(b.code ?? ""), String(b.fingerprint ?? ""), b.vault !== false));
      },
    },
    "/api/servers/state": {
      get: async ({ url }) => json(await serverState(url.searchParams.get("name") ?? "")),
    },
  };
}
