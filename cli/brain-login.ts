// brain-login.ts — signing this machine in to the brain: `claude-multi brain-login` and the console's
// Sign in button (Connections). Nothing is copied by hand.
//
// The brain's own OAuth (brain/auth.ts) with scope `machine`: a listener on a random 127.0.0.1 port is
// the redirect, the client registers itself with it, PKCE ties the code to this run and `state` to
// this request. The person signs in on the brain's page (account, passphrase, TOTP); the answer is a
// personal token named after this machine and the account's backup key, which go straight into the
// vault (brain/<account>, the token and its backup-key field) and from there to the other machines.

import { ACCOUNTS } from "./mcp.ts";
import { readJson } from "./lib.ts";
import type { Account } from "../shared/mcp/lib/accounts.ts";
import { pkce } from "../shared/mcp/lib/google.ts";
import { setSecret } from "../shared/mcp/lib/vault.ts";
import { probeAccount } from "./vault.ts";

type Done = (r: { ok: boolean; message: string }) => void;

/** Pure: the brain's sign-in page for this request. */
export function brainAuthUrl(base: string, client: string, redirect: string, challenge: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    scope: "machine",
  });
  return `${base}/authorize?${q}`;
}

/**
 * Starts a sign-in: returns the brain's page at once; `onDone` is told how it ended when the browser
 * comes back (or after five minutes).
 */
export async function startBrainLogin(
  account: string,
  onDone: Done,
  { fetcher = fetch, store = setSecret }: { fetcher?: typeof fetch; store?: typeof setSecret } = {},
): Promise<string> {
  const accounts = (await readJson<{ accounts: Account[] }>(ACCOUNTS))?.accounts ?? [];
  const a = accounts.find((x) => x.service === "brain" && x.name === account);
  if (!a?.url) throw new Error(`no brain account "${account}" with an address in accounts.json: add it first`);
  const base = a.url.replace(/\/+$/, "");
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();
  const ac = new AbortController();
  let port = 0;
  const finish: Done = (r) => {
    setTimeout(() => ac.abort(), 500);
    void srv.finished.then(() => onDone(r), () => onDone(r));
  };
  const timer = setTimeout(() => finish({ ok: false, message: "no answer from the browser within 5 minutes" }), 300000);
  let client = "";
  const srv = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: ac.signal,
    onListen: (addr) => {
      port = addr.port;
    },
  }, async (req) => {
    const u = new URL(req.url);
    if (u.pathname !== "/callback") return new Response("not found", { status: 404 });
    clearTimeout(timer);
    const page = (msg: string) =>
      new Response(
        `<!doctype html><meta charset="utf-8"><title>claude-multi</title><body style="font:16px system-ui;padding:40px">${msg}</body>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    if (u.searchParams.get("state") !== state) {
      finish({ ok: false, message: "the answer did not match this request" });
      return page("Questa risposta non appartiene alla richiesta: non è stato salvato niente.");
    }
    try {
      const r = await fetcher(`${base}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: u.searchParams.get("code") ?? "",
          client_id: client,
          redirect_uri: `http://127.0.0.1:${port}/callback`,
          code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(15000),
      });
      const d = await r.json().catch(() => ({})) as {
        access_token?: string;
        backup_key?: string;
        account?: string;
        error_description?: string;
        error?: string;
      };
      if (!r.ok || !d.access_token) {
        throw new Error(`the brain answered ${r.status}: ${d.error_description ?? d.error ?? "no token"}`);
      }
      const probe = await probeAccount(a, d.access_token);
      if (!probe.ok) throw new Error(`the new token does not open the brain (${probe.detail})`);
      await store("brain", account, d.access_token);
      if (d.backup_key) await store("brain", account, d.backup_key, "backup-key");
      const who = d.account ? ` as ${d.account}` : "";
      finish({ ok: true, message: `brain/${account} signed in${who}: token and backup key in the vault` });
      return page(
        `Collegato${
          d.account ? ` come <b>${d.account}</b>` : ""
        }: token e chiave di backup sono nel vault. Puoi chiudere questa scheda.`,
      );
    } catch (e) {
      finish({ ok: false, message: (e as Error).message });
      return page(`Non collegato: ${(e as Error).message}`);
    }
  });
  void srv.finished.catch(() => {});
  while (!port) await new Promise((r) => setTimeout(r, 10));
  const redirect = `http://127.0.0.1:${port}/callback`;
  try {
    const reg = await fetcher(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: `claude-multi su ${Deno.hostname()}`, redirect_uris: [redirect] }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await reg.json().catch(() => ({})) as { client_id?: string };
    if (!reg.ok || !d.client_id) {
      throw new Error(`the brain at ${base} did not register this machine (HTTP ${reg.status})`);
    }
    client = d.client_id;
  } catch (e) {
    clearTimeout(timer);
    ac.abort();
    throw e;
  }
  return brainAuthUrl(base, client, redirect, challenge, state);
}

export async function brainLoginCommand(account = "brain"): Promise<number> {
  const done = Promise.withResolvers<{ ok: boolean; message: string }>();
  const url = await startBrainLogin(account, done.resolve);
  console.log(`Opening the brain's sign-in page. If no browser opens, visit:\n\n  ${url}\n`);
  try {
    new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn();
  } catch { /* the link above */ }
  const r = await done.promise;
  console.log(r.message);
  return r.ok ? 0 : 1;
}
