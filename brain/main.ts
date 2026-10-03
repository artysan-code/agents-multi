#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
// brain — Samuel's brain as a service: his memory and his tasks in one place, reached by every
// Claude he uses (the apps and claude.ai as a custom connector, Claude Code and Desktop) over MCP,
// and by his machines over a personal token. Runs on his server (Coolify), one SQLite file in
// BRAIN_DATA; the design is in brain/README.md.
//
//   deno run -A brain/main.ts          serve
//   deno run -A brain/main.ts totp     a new TOTP secret, and the line to add to an authenticator app

import { AsyncLocalStorage } from "node:async_hooks";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/webStandardStreamableHttp.js";
import { fromFile, type TaskStore, toFile, useTaskStore } from "../shared/mcp/lib/tasks.ts";
import { Auth, base32Encode } from "./auth.ts";
import { indexer } from "./embed.ts";
import { accountPage, authorizePage, html, signInPage } from "./pages.ts";
import { Store } from "./store.ts";
import { brainServer } from "./tools.ts";
import { brainApi } from "./api.ts";
import { snapshot } from "./backup.ts";

if (Deno.args[0] === "totp") {
  const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
  console.log(`BRAIN_TOTP_SECRET=${secret}`);
  console.log(`otpauth://totp/Brain:samuel?secret=${secret}&issuer=Brain&digits=6&period=30`);
  Deno.exit(0);
}

const env = (k: string, d?: string) => Deno.env.get(k) ?? d;
const URL_ = (env("BRAIN_URL") ?? "").replace(/\/+$/, "");
const PASS = env("BRAIN_PASSPHRASE") ?? "";
const TOTP = env("BRAIN_TOTP_SECRET") || null;
const DEV = env("BRAIN_DEV") === "1";
if (!URL_ || PASS.length < 12 || (!TOTP && !DEV)) {
  console.error("brain: BRAIN_URL, BRAIN_PASSPHRASE (12+ characters) and BRAIN_TOTP_SECRET are required (BRAIN_DEV=1 allows no TOTP)");
  Deno.exit(2);
}
const DATA = env("BRAIN_DATA", "/data")!;
await Deno.mkdir(DATA, { recursive: true });

const store = new Store(`${DATA}/brain.db`);
const auth = new Auth(store.db, { url: URL_, passphrase: PASS, totpSecret: TOTP });
const embedCfg = { url: env("BRAIN_EMBED_URL", "http://ollama:11434")!, model: env("BRAIN_EMBED_MODEL", "bge-m3")! };
const index = indexer(store, embedCfg);

// who is writing, for every revision: set per request, read by the task store too
const caller = new AsyncLocalStorage<string>();
const by = () => caller.getStore() ?? "brain";

// tasks live here as documents under tasks/, with the rules of shared/mcp/lib/tasks.ts on top
const taskStore: TaskStore = {
  list: () => Promise.resolve(
    (store.db.prepare("select body from docs where deleted = 0 and path like 'tasks/t-%'").all() as { body: string }[])
      .map((r) => fromFile(r.body)).filter((t) => !!t) as never,
  ),
  get: (id) => Promise.resolve(fromFile(store.get(`tasks/${id}.md`)?.body ?? "")),
  write: (t) => { store.write(`tasks/${t.id}.md`, toFile(t), by()); index.kick(); return Promise.resolve(); },
};
useTaskStore(taskStore);

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-expose-headers": "www-authenticate, mcp-session-id" };
const SESSION_COOKIE = (s: string) => `brain_session=${s}; Path=/account; HttpOnly; SameSite=Strict; Max-Age=900${URL_.startsWith("https:") ? "; Secure" : ""}`;

async function handle(req: Request): Promise<Response> {
  const u = new URL(req.url);
  const p = u.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" } });

  if (p === "/health") return json({ ok: true, documents: (store.db.prepare("select count(*) n from docs where deleted = 0").get() as { n: number }).n, index: index.status() });

  // ---------------- discovery
  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") return json(auth.resourceMeta, 200, CORS);
  if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") return json(auth.serverMeta, 200, CORS);

  // ---------------- OAuth
  if (p === "/register" && req.method === "POST") {
    const r = auth.register(await req.json().catch(() => ({})));
    return json(r.json, r.status, CORS);
  }
  if (p === "/authorize") {
    const params = req.method === "POST" ? new URLSearchParams(await req.text()) : u.searchParams;
    const check = auth.checkAuthorize(params);
    if (!check.ok) return html(authorizePage("Claude", new URLSearchParams(), !!TOTP, check.message), 400);
    const oauth = new URLSearchParams([...params].filter(([k]) => !["passphrase", "code"].includes(k)));
    if (req.method === "GET") return html(authorizePage(check.client.name, oauth, !!TOTP));
    const r = await auth.signIn(params.get("passphrase") ?? "", params.get("code") ?? "");
    if (r !== "ok") return html(authorizePage(check.client.name, oauth, !!TOTP, r === "locked" ? "Troppi tentativi: riprova tra un quarto d'ora." : "Passphrase o codice sbagliati."), 401);
    return new Response(null, { status: 302, headers: { location: await auth.issueCode(oauth), "cache-control": "no-store" } });
  }
  if (p === "/token" && req.method === "POST") {
    const r = await auth.token(new URLSearchParams(await req.text()));
    return json(r.json, r.status, CORS);
  }

  // ---------------- the account page
  if (p === "/account" || p.startsWith("/account/")) {
    if (p === "/account/login" && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      const r = await auth.signIn(f.get("passphrase") ?? "", f.get("code") ?? "");
      if (r !== "ok") return html(signInPage(!!TOTP, r === "locked" ? "Troppi tentativi: riprova tra un quarto d'ora." : "Passphrase o codice sbagliati."), 401);
      return new Response(null, { status: 303, headers: { location: "/account", "set-cookie": SESSION_COOKIE(await auth.newSession()) } });
    }
    if (!(await auth.session(req))) return html(signInPage(!!TOTP));
    let fresh: { name: string; token: string } | undefined;
    if (req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      if (p === "/account/token" && f.get("name")?.trim()) fresh = { name: f.get("name")!.trim(), token: await auth.createPersonal(f.get("name")!.trim()) };
      if (p === "/account/revoke" && f.get("hash")) auth.revoke(f.get("hash")!);
      if (p === "/account/revoke-claude") auth.revokeAllClaude();
    }
    return html(accountPage(auth.personalTokens(), auth.connections(), fresh));
  }

  // ---------------- everything below needs a token
  const who = await auth.caller(req);
  if (!who) return p === "/mcp" || p.startsWith("/api/") || p === "/backup" ? withCors(auth.challenge()) : new Response("not found", { status: 404 });

  if (p === "/mcp") {
    // stateless: a server and a transport per request, nothing kept between them
    const server = brainServer({ store, embed: embedCfg, by, changed: index.kick });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await caller.run(who, () => transport.handleRequest(req));
    return withCors(res);
  }
  // the tasks as files, for Samuel's machines (the console, the reminders, the local tasks tools):
  // the TaskStore of shared/mcp/lib/brain-tasks.ts on the other side; the rules run there
  if (p === "/api/tasks" && req.method === "GET") {
    const rows = store.db.prepare("select body from docs where deleted = 0 and path like 'tasks/t-%'").all() as { body: string }[];
    return json({ tasks: rows.map((r) => r.body) });
  }
  const one = p.match(/^\/api\/tasks\/(t-[\w-]+)$/);
  if (one && req.method === "GET") {
    const d = store.get(`tasks/${one[1]}.md`);
    return d ? json({ task: d.body }) : json({ error: "no such task" }, 404);
  }
  if (one && req.method === "PUT") {
    const body = await req.text();
    if (fromFile(body)?.id !== one[1]) return json({ error: "not a task file, or its id is not the one in the path" }, 400);
    await caller.run(who, () => taskStore.write(fromFile(body)!));
    return json({ written: one[1] });
  }
  // the memory read over HTTP, for the console's Brain page (brain/api.ts): only reads
  if (p.startsWith("/api/brain/") && req.method === "GET") {
    const r = await brainApi({ store, embed: embedCfg, by, changed: index.kick }, u);
    if (r) return json(r.body, r.status);
  }
  // what the machines compare before fetching a backup: it changes with every write, never otherwise
  if (p === "/backup/state" && who.startsWith("token:")) {
    const r = store.db.prepare("select count(*) n, max(at) last from revisions").get() as { n: number; last: string | null };
    return json({ version: `${r.n}:${r.last ?? ""}`, revisions: r.n, last: r.last });
  }
  if (p === "/backup" && who.startsWith("token:")) {
    const key = env("BRAIN_BACKUP_KEY");
    if (!key) return json({ error: "no BRAIN_BACKUP_KEY on the server" }, 503);
    return new Response(await snapshot(store, `${DATA}/brain.db`, key), {
      headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="brain-${new Date().toISOString().slice(0, 10)}.brn"`, "cache-control": "no-store" },
    });
  }
  return json({ error: "not found" }, 404);
}

const withCors = (r: Response) => {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
};

Deno.serve({ port: Number(env("PORT", "8080")), hostname: env("HOST", "0.0.0.0") }, async (req) => {
  try {
    return await handle(req);
  } catch (e) {
    console.error(e);
    return json({ error: (e as Error).message }, 500);
  }
});
console.log(`brain on ${URL_} (data ${DATA}, embeddings ${embedCfg.model} at ${embedCfg.url})`);
