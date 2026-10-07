// google.ts — connecting Google accounts: the OAuth client once, then each account through its
// consent page. Used by `agents google …` and by the console's Connect button.
//
// The flow is the one Google documents for desktop apps: a listener on a random 127.0.0.1 port is
// the redirect address, PKCE ties the code to this run, `state` to this request. The refresh token
// goes straight into the vault; the account's address is written next to its name in accounts.json.

import { ACCOUNTS } from "./mcp/registry.ts";
import { readJson } from "./lib/fs.ts";
import type { Account } from "../../shared/mcp/lib/accounts.ts";
import { authUrl, exchangeCode, loadClient, parseClientJson, pkce } from "../../shared/mcp/lib/google.ts";
import { setSecret } from "../../shared/mcp/lib/vault.ts";

export async function storeClient(json: string): Promise<string> {
  const c = parseClientJson(json);
  await setSecret("google-oauth", "client", c.id, "id");
  await setSecret("google-oauth", "client", c.secret, "secret");
  return c.id.split("-")[0];
}

/**
 * Starts a connection: returns the consent page's address at once, and a promise that settles when
 * the browser comes back (or after five minutes). `onDone` is told how it ended either way.
 */
export async function startConnect(
  account: string,
  onDone: (r: { ok: boolean; message: string }) => void,
): Promise<string> {
  const accounts = (await readJson<{ accounts: Account[] }>(ACCOUNTS))?.accounts ?? [];
  const a = accounts.find((x) => x.service === "google" && x.name === account);
  if (!a) throw new Error(`no google account "${account}" in accounts.json: add it first`);
  const client = await loadClient();
  const { verifier, challenge } = await pkce();
  const state = crypto.randomUUID();
  const ac = new AbortController();
  let port = 0;
  // onDone once the listener has closed: the page is out to the browser by then, and the CLI may exit
  const finish = (r: { ok: boolean; message: string }) => {
    setTimeout(() => ac.abort(), 500);
    void srv.finished.then(() => onDone(r), () => onDone(r));
  };
  const timer = setTimeout(() => finish({ ok: false, message: "no answer from the browser within 5 minutes" }), 300000);
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
        `<!doctype html><meta charset="utf-8"><title>agents-multi</title><body style="font:16px system-ui;padding:40px">${msg}</body>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    if (u.searchParams.get("state") !== state) {
      finish({ ok: false, message: "the answer did not match this request" });
      return page("This answer does not belong to the request: nothing was stored.");
    }
    if (u.searchParams.get("error")) {
      finish({ ok: false, message: `Google: ${u.searchParams.get("error")}` });
      return page("Access was not granted: nothing was stored.");
    }
    try {
      const r = await exchangeCode(
        client,
        u.searchParams.get("code") ?? "",
        verifier,
        `http://127.0.0.1:${port}/callback`,
      );
      await setSecret("google", account, r.refresh);
      if (r.email) {
        const raw = await readJson<{ accounts: Account[] } & Record<string, unknown>>(ACCOUNTS);
        const hit = raw?.accounts.find((x) => x.service === "google" && x.name === account);
        if (raw && hit && hit.email !== r.email) {
          hit.email = r.email;
          await Deno.writeTextFile(ACCOUNTS, JSON.stringify(raw, null, 2) + "\n");
        }
      }
      finish({ ok: true, message: `google/${account} connected${r.email ? ` as ${r.email}` : ""}` });
      return page(`Connected${r.email ? ` as <b>${r.email}</b>` : ""}. You can close this tab.`);
    } catch (e) {
      finish({ ok: false, message: (e as Error).message });
      return page(`Not connected: ${(e as Error).message}`);
    }
  });
  void srv.finished.catch(() => {});
  while (!port) await new Promise((r) => setTimeout(r, 10));
  return authUrl(client, `http://127.0.0.1:${port}/callback`, challenge, state, a.email);
}

export async function googleCommand(args: string[]): Promise<number> {
  const [sub, arg] = args;
  if (sub === "client" && arg) {
    const prefix = await storeClient(await Deno.readTextFile(arg));
    console.log(`OAuth client ${prefix}… stored in the vault. The downloaded file is no longer needed: delete it.`);
    return 0;
  }
  if (sub === "connect" && arg) {
    const done = Promise.withResolvers<{ ok: boolean; message: string }>();
    const url = await startConnect(arg, done.resolve);
    console.log(`Opening the consent page. If no browser opens, visit:\n\n  ${url}\n`);
    try {
      new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn();
    } catch { /* the link above */ }
    const r = await done.promise;
    console.log(r.message);
    return r.ok ? 0 : 1;
  }
  console.error("usage: agents google client <client_secret….json> | google connect <account>");
  return 2;
}
