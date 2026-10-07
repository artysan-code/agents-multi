#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
// brain — the brains of several people as one service: each one's memory and tasks, reached by
// every Claude they use (the apps and claude.ai as a custom connector, Claude Code and Desktop) over
// MCP, and by their machines over a personal token. Each person has an account (users.ts) and a
// database of their own (tenants.ts); every request runs as the account its token or session
// belongs to. Design: apps/brain/README.md.
//
//   deno run -A apps/brain/main.ts          serve
//   deno run -A apps/brain/main.ts totp     a new TOTP secret, and the line to add to an authenticator app

import { AsyncLocalStorage } from "node:async_hooks";
import { fromFileUrl } from "jsr:@std/path@1/from-file-url";
import { DatabaseSync } from "node:sqlite";
import { WebStandardStreamableHTTPServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/webStandardStreamableHttp.js";
import {
  fromFile,
  StaleError,
  type TaskStore,
  toFile,
  useTaskStore,
  useZone,
  validZone,
} from "../../shared/mcp/lib/tasks.ts";
import { Auth, base32Encode, type Caller, SESSION_SECONDS } from "./auth.ts";
import { boardRoute } from "./board.ts";
import {
  accountPage,
  type AdminView,
  authorizePage,
  html,
  invitedPage,
  invitePage,
  SIGNED_OUT_ERROR,
  signInPage,
} from "./pages.ts";
import { loadSite, privacyPage, type Site, siteFile, siteMoved, siteSize } from "./public.ts";
import { log, logRequest } from "./log.ts";
import { brainServer } from "./tools.ts";
import { brainApi } from "./api.ts";
import { bodyLimit, Buckets, capped, clientIp, fromOwnPages, hardened, isTooLarge } from "./guard.ts";
import { snapshot } from "./backup.ts";
import { startBackups } from "./backups.ts";
import { type Owner, owner, ownerFrom, useOwner } from "../../shared/mcp/lib/owner.ts";
import { masterKey, type User, Users } from "./users.ts";
import { type Tenant, tenantFile, Tenants } from "./tenants.ts";

if (Deno.args[0] === "totp") {
  const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
  console.log(`BRAIN_TOTP_SECRET=${secret}`);
  console.log(
    `otpauth://totp/Brain:${encodeURIComponent(owner().id)}?secret=${secret}&issuer=Brain&digits=6&period=30`,
  );
  Deno.exit(0);
}

const env = (k: string, d?: string) => Deno.env.get(k) || d;
const URL_ = (env("BRAIN_URL") ?? "").replace(/\/+$/, "");
const DEV = env("BRAIN_DEV") === "1";
const fail = (m: string) => {
  log.error(m);
  Deno.exit(2);
};
if (!URL_) fail("BRAIN_URL is required");
if (!env("BRAIN_MASTER_KEY")) {
  fail(
    "BRAIN_MASTER_KEY (32 random bytes, base64) is required: it encrypts every account's TOTP secret and backup key",
  );
}
const DATA = env("BRAIN_DATA", "/data")!;
await Deno.mkdir(DATA, { recursive: true });

const accountsDb = new DatabaseSync(`${DATA}/accounts.db`);
accountsDb.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
const users = new Users(accountsDb, await masterKey(env("BRAIN_MASTER_KEY")!), DEV);
const auth = new Auth(accountsDb, users, { url: URL_ });
const embedCfg = { url: env("BRAIN_EMBED_URL", "http://ollama:11434")!, model: env("BRAIN_EMBED_MODEL", "bge-m3")! };

// whose request this is and how it came in: set per request, read by the stores, the task rules
// (useTaskStore) and the owner of the prompts (useOwner)
interface Ctx {
  user: User;
  label: string;
  tenant: Tenant;
}
const ctx = new AsyncLocalStorage<Ctx>();
const by = () => ctx.getStore()?.label ?? "brain";
const tenants = new Tenants(DATA, embedCfg, by, (id) => users.get(id)?.language ?? "Italian");
const here = (): Ctx => {
  const c = ctx.getStore();
  if (!c) throw new Error("no account for this request");
  return c;
};
const ownerOf = (u: User): Owner => ownerFrom({ id: u.id, name: u.name, language: u.language });
useOwner(() => {
  const c = ctx.getStore();
  return c ? ownerOf(c.user) : null;
});
const tasks: TaskStore = {
  list: () => here().tenant.tasks.list(),
  get: (id) => here().tenant.tasks.get(id),
  write: (t, base) => here().tenant.tasks.write(t, base),
};
useTaskStore(tasks);
// a person's days are in their own zone (the account page sets it), or the service's: BRAIN_TIMEZONE,
// else the zone the process runs in (TZ)
const ZONE = env("BRAIN_TIMEZONE") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
if (!validZone(ZONE)) fail(`BRAIN_TIMEZONE: unknown time zone ${ZONE}`);
const zoneOf = (u: User) => u.timezone ?? ZONE;
useZone(() => {
  const c = ctx.getStore();
  return c ? zoneOf(c.user) : undefined;
});
/** Runs `fn` as an account: its database, its owner, its name on every revision. */
const as = <T>(user: User, label: string, fn: () => T): T =>
  ctx.run({ user, label, tenant: tenants.open(user.id) }, fn);

// ---------------------------------------------------------------- the first account
// A new service makes its administrator as an invitation, like everyone else: the link goes to the
// log (on Coolify, the application's logs), and whoever installed it opens it and chooses a
// passphrase and a TOTP secret. Until the administrator has accepted, every start writes a fresh
// link, since an old one cannot be read back. Nothing secret has to sit in the environment.
// (BRAIN_PASSPHRASE and BRAIN_TOTP_SECRET still make a ready account at once where they are given:
// a local run, the end-to-end test.) A service that kept one person's brain (/data/brain.db) becomes
// the administrator's: the file moves under users/, and the tokens of its Claude connections and
// machines are carried over, so nothing has to be connected again.
if (!users.count()) {
  const o = owner();
  const id = env("BRAIN_ADMIN_ID", o.id)!.toLowerCase();
  const pass = env("BRAIN_PASSPHRASE"), totp = env("BRAIN_TOTP_SECRET") ?? null;
  if (pass) {
    if (pass.length < 12 || (!totp && !DEV)) {
      fail("BRAIN_PASSPHRASE needs 12+ characters and BRAIN_TOTP_SECRET (BRAIN_DEV=1 allows no TOTP)");
    }
    await users.bootstrap({
      id,
      name: o.name,
      language: o.language,
      passphrase: pass,
      totpSecret: totp,
      backupKey: env("BRAIN_BACKUP_KEY"),
    });
  } else {
    await users.invite(id, o.name === "the user" ? id : o.name, o.language, true).catch((e) =>
      fail(`BRAIN_ADMIN_ID: ${(e as Error).message}`)
    );
  }
  const old = `${DATA}/brain.db`, dest = tenantFile(DATA, id);
  if ((await Deno.stat(old).catch(() => null)) && !(await Deno.stat(dest).catch(() => null))) {
    const db = new DatabaseSync(old);
    const carried = auth.adopt(db, id);
    db.exec("pragma wal_checkpoint(truncate)");
    // the tokens now live in accounts.db: the person's database keeps only their brain
    for (const t of ["oauth_clients", "oauth_codes", "tokens", "sessions", "login_failures"]) {
      db.exec(`drop table if exists ${t}`);
    }
    db.close();
    await Deno.mkdir(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    for (const s of ["", "-wal", "-shm"]) await Deno.rename(`${old}${s}`, `${dest}${s}`).catch(() => {});
    log.info("legacy database adopted", { from: old, account: id, tokens: carried });
  }
  log.info("first account created", { account: id, admin: true });
}
const admin = users.list().find((u) => u.admin);
if (admin && !admin.ready) {
  // plain output, not a log event: the invitation is a secret meant for the operator reading the console
  console.log(
    `brain: the administrator ${admin.id} has not signed up yet — their invitation (one use, 7 days): ${URL_}/invite?t=${await users
      .reinvite(admin.id)}`,
  );
}
// every ready account's brain is opened now, so its indexer runs from the start
for (const u of users.list()) if (u.ready && !u.disabled) tenants.open(u.id);

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
};
const HTTPS = URL_.startsWith("https:");
const SECURE = HTTPS ? "; Secure" : "";
// Lax, not Strict: a link to the board from elsewhere (a notification, the console) arrives signed in;
// a form posted from another site still carries no cookie, and one from a sibling subdomain (the same
// site) is refused by the origin check in handle()
const SESSION_COOKIE = (s: string, age = SESSION_SECONDS) =>
  `brain_session=${s}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${SECURE}`;
/** Pure: a page of this service to go back to after signing in, or the account page. */
const nextPage = (n: string | null) => n && /^\/(account|tasks)(\/[\w-]*)*(\?[^\s]*)?$/.test(n) ? n : "/account";
const LOCKED = "Troppi tentativi: riprova tra un quarto d'ora.";
const BUSY = "Troppi accessi in corso: riprova tra qualche secondo.";
const refused = (r: "wrong" | "locked" | "busy") => r === "locked" ? LOCKED : r === "busy" ? BUSY : SIGNED_OUT_ERROR;
// per address: the forms a person signs in with (ten, then one every six seconds), the token
// endpoint Claude's clients call (thirty, then one every two seconds), and registering a client
// (ten, then one a minute). Claude's servers call from a few shared addresses: generous on purpose.
const FORMS = new Buckets(10, 6_000), OAUTH = new Buckets(30, 2_000), REGISTER = new Buckets(10, 60_000);
const IP_HEADER = env("BRAIN_CLIENT_IP_HEADER")?.toLowerCase();
/** Pure: which bucket a request draws from, if any. */
const bucketOf = (method: string, p: string) =>
  method !== "POST"
    ? null
    : p === "/account/login" || p === "/authorize" || p === "/invite"
    ? FORMS
    : p === "/token"
    ? OAUTH
    : p === "/register"
    ? REGISTER
    : null;
const TOTP = !DEV;
const SITE: Site = {
  url: URL_,
  siteUrl: (env("BRAIN_SITE_URL") ?? URL_).replace(/\/+$/, ""),
  operator: env("BRAIN_OPERATOR", owner().name)!,
  contact: env("BRAIN_CONTACT", "")!,
  hosting: env("BRAIN_HOSTING", "un server privato")!,
};
const SITE_DIR = env("BRAIN_SITE", fromFileUrl(new URL("../site/dist", import.meta.url)))!;
// the site on an address of its own answers with the site and the privacy notice, nothing of the brain
const SITE_HOST = SITE.siteUrl !== URL_ ? new URL(SITE.siteUrl).host : null;
// the built site, read once: files, their ETags and headers all stay in memory
const SITE_FILES = await loadSite(SITE_DIR, SITE);
log.info("site loaded", { dir: SITE_DIR, files: SITE_FILES.size, bytes: siteSize(SITE_FILES) });
const otpauth = (id: string, secret: string) =>
  `otpauth://totp/Brain:${encodeURIComponent(id)}?secret=${secret}&issuer=Brain&digits=6&period=30`;

async function handle(req: Request, ip: string): Promise<Response> {
  const u = new URL(req.url);
  const p = u.pathname;
  // the forms of the account page, the board and the sign-in act for whoever is signed in: only
  // from this service's own pages
  if (
    req.method === "POST" && !(SITE_HOST && u.host === SITE_HOST) &&
    (p.startsWith("/account") || p.startsWith("/tasks") || p === "/authorize" || p === "/invite") &&
    !fromOwnPages(req.headers, URL_)
  ) return new Response("cross-origin form refused\n", { status: 403, headers: { "content-type": "text/plain" } });
  const wait = bucketOf(req.method, p)?.take(ip) ?? 0;
  if (wait) {
    return new Response("too many requests\n", {
      status: 429,
      headers: { "retry-after": String(wait), "content-type": "text/plain", ...CORS },
    });
  }
  if (SITE_HOST && u.host === SITE_HOST) {
    if (p === "/privacy") return html(privacyPage(SITE), 200, { "x-robots-tag": "all" });
    const r = req.method === "GET" || req.method === "HEAD" ? siteFile(SITE_FILES, p, req.headers) : null;
    return r ?? siteFile(SITE_FILES, "/404.html", req.headers, 404) ?? new Response("not found", { status: 404 });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...CORS, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" },
    });
  }

  // liveness: the process answers. Readiness: its accounts database answers too. Neither says more,
  // to anyone: what is wrong goes to the log. The embedding model is not part of it: without it,
  // search answers with words alone, and taking the service out of the proxy would be worse.
  if (p === "/health") return json({ ok: true });
  if (p === "/ready") {
    try {
      accountsDb.prepare("select 1").get();
      return json({ ok: true });
    } catch (e) {
      log.error("not ready", { err: e });
      return json({ ok: false }, 503);
    }
  }

  // ---------------- discovery
  if (p === "/.well-known/oauth-protected-resource" || p === "/.well-known/oauth-protected-resource/mcp") {
    return json(auth.resourceMeta, 200, CORS);
  }
  if (p === "/.well-known/oauth-authorization-server" || p === "/.well-known/openid-configuration") {
    return json(auth.serverMeta, 200, CORS);
  }

  // ---------------- OAuth
  if (p === "/register" && req.method === "POST") {
    const r = auth.register(await req.json().catch(() => ({})));
    return json(r.json, r.status, CORS);
  }
  if (p === "/authorize") {
    const params = req.method === "POST" ? new URLSearchParams(await req.text()) : u.searchParams;
    const check = auth.checkAuthorize(params);
    if (!check.ok) return html(authorizePage("Claude", new URLSearchParams(), TOTP, check.message), 400);
    const oauth = new URLSearchParams([...params].filter(([k]) => !["user", "passphrase", "code"].includes(k)));
    if (req.method === "GET") return html(authorizePage(check.client.name, oauth, TOTP, "", check.machine));
    const who = (params.get("user") ?? "").trim().toLowerCase();
    const r = await auth.signIn(who, params.get("passphrase") ?? "", params.get("code") ?? "", ip);
    if (r !== "ok") {
      return html(authorizePage(check.client.name, oauth, TOTP, refused(r), check.machine), r === "busy" ? 503 : 401);
    }
    return new Response(null, {
      status: 302,
      headers: { location: await auth.issueCode(oauth, who), "cache-control": "no-store" },
    });
  }
  if (p === "/token" && req.method === "POST") {
    const r = await auth.token(new URLSearchParams(await req.text()));
    return json(r.json, r.status, CORS);
  }

  // ---------------- an invitation: the person chooses their passphrase and adds the TOTP secret
  if (p === "/invite") {
    const f = req.method === "POST" ? new URLSearchParams(await req.text()) : u.searchParams;
    const t = f.get("t") ?? "";
    const inv = await users.invitation(t);
    if (!inv) return html(invitedPage("", "Questo invito è scaduto o è già stato usato: chiedine uno nuovo."), 410);
    const show = (error = "") =>
      html(
        invitePage(inv.user.name, t, inv.totpSecret, otpauth(inv.user.id, inv.totpSecret), error),
        error ? 400 : 200,
      );
    if (req.method !== "POST") return show();
    if ((f.get("passphrase") ?? "") !== (f.get("again") ?? "")) return show("Le due passphrase sono diverse.");
    const r = await users.accept(t, f.get("passphrase") ?? "", f.get("code") ?? "");
    if (typeof r === "string") return show(r);
    tenants.open(r.id);
    return html(invitedPage(r.id));
  }

  // ---------------- the account page
  if (p === "/account" || p.startsWith("/account/")) {
    if (p === "/account/login" && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      const who = (f.get("user") ?? "").trim().toLowerCase();
      const r = await auth.signIn(who, f.get("passphrase") ?? "", f.get("code") ?? "", ip);
      const next = nextPage(f.get("next"));
      if (r !== "ok") return html(signInPage(TOTP, refused(r), next), r === "busy" ? 503 : 401);
      return new Response(null, {
        status: 303,
        headers: { location: next, "set-cookie": SESSION_COOKIE(await auth.newSession(who)) },
      });
    }
    const id = await auth.session(req);
    const me = id ? users.get(id) : null;
    if (!me) return html(signInPage(TOTP));
    if (p === "/account/logout" && req.method === "POST") {
      await auth.endSession(req);
      return new Response(null, {
        status: 303,
        headers: { location: "/account", "set-cookie": SESSION_COOKIE("", 0) },
      });
    }
    const extra: { fresh?: { name: string; token: string }; backupKey?: string; admin?: AdminView } = {};
    const adminView: AdminView = { users: [] };
    if (req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      const name = f.get("name")?.trim() ?? "";
      if (p === "/account/token" && name) extra.fresh = { name, token: await auth.createPersonal(me.id, name) };
      if (p === "/account/revoke" && f.get("hash")) auth.revoke(me.id, f.get("hash")!);
      if (p === "/account/revoke-claude") auth.revokeAllClaude(me.id);
      if (p === "/account/backup-key") extra.backupKey = await users.backupKey(me.id);
      if (p === "/account/timezone") {
        const tz = f.get("timezone") ?? "";
        if (tz && !validZone(tz)) return new Response("fuso orario sconosciuto\n", { status: 400 });
        users.setTimezone(me.id, tz === "" || tz === ZONE ? null : tz);
        return new Response(null, { status: 303, headers: { location: "/account" } });
      }
      if (p.startsWith("/account/admin/")) {
        if (!me.admin) return html(signInPage(TOTP, "Solo l'amministratore gestisce gli account."), 403);
        const target = (f.get("id") ?? "").trim().toLowerCase();
        try {
          if (p === "/account/admin/invite") {
            adminView.link = {
              id: target,
              url: `${URL_}/invite?t=${await users.invite(target, name, f.get("language") ?? "Italian")}`,
            };
          } else if (p === "/account/admin/reinvite") {
            if (users.get(target)?.admin) throw new Error("l'amministratore non si reinvita");
            const link = await users.reinvite(target);
            auth.revokeAll(target); // a new invitation means the old ways in are gone
            adminView.link = { id: target, url: `${URL_}/invite?t=${link}` };
          } else if (p === "/account/admin/disable" || p === "/account/admin/enable") {
            users.setDisabled(target, p.endsWith("disable"));
            if (p.endsWith("disable")) auth.revokeAll(target);
          }
        } catch (e) {
          adminView.error = (e as Error).message;
        }
      }
    }
    if (me.admin) extra.admin = { ...adminView, users: users.list() };
    return html(
      accountPage(users.get(me.id)!, auth.personalTokens(me.id), auth.connections(me.id), { ...extra, zone: ZONE }),
    );
  }

  // ---------------- the privacy notice (the rest of what is public is the site, below)
  if (p === "/privacy") return html(privacyPage(SITE), 200, { "x-robots-tag": "all" });

  // ---------------- the board: the tasks on the web, signed in like the account page
  if (p === "/tasks" || p.startsWith("/tasks/")) {
    const id = await auth.session(req);
    const me = id ? users.get(id) : null;
    // a change sent after the session ended comes back to its page, not to the form's address
    if (!me) {
      return html(
        signInPage(TOTP, "", req.method === "GET" ? `${p}${u.search}` : p.match(/^\/tasks\/t-[\w-]+/)?.[0] ?? "/tasks"),
        req.method === "GET" ? 200 : 401,
      );
    }
    return await as(me, "web", () => boardRoute(req, u, me, html));
  }

  // ---------------- agents-multi's site: the landing and the docs, built into apps/site/dist
  // (on the brain's address when the site has none of its own; otherwise a visitor is sent there)
  if (req.method === "GET" || req.method === "HEAD") {
    if (SITE_HOST && p === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain" } });
    }
    const moved = siteMoved(SITE_FILES, u, SITE);
    if (moved) return new Response(null, { status: 301, headers: { location: moved } });
    const r = SITE_HOST ? null : siteFile(SITE_FILES, p, req.headers);
    if (r) return r;
  }

  // ---------------- everything below needs a token, and runs as its account
  const who: Caller | null = await auth.caller(req);
  if (!who) {
    if (p === "/mcp" || p.startsWith("/api/") || p.startsWith("/backup")) return withCors(auth.challenge());
    return SITE_HOST
      ? new Response("not found", { status: 404 })
      : siteFile(SITE_FILES, "/404.html", req.headers, 404) ?? new Response("not found", { status: 404 });
  }
  const user = users.get(who.user)!;
  return await as(user, who.label, () => served(req, u, who));
}

/** What a request with a valid token gets, already running as its account. */
async function served(req: Request, u: URL, who: Caller): Promise<Response> {
  const p = u.pathname;
  const { tenant } = here();
  const { store, index } = tenant;
  const toolCtx = { store, embed: embedCfg, by, changed: index.kick };

  if (p === "/mcp") {
    // stateless: a server and a transport per request, nothing kept between them
    const server = brainServer(toolCtx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return withCors(await transport.handleRequest(req));
  }
  // the tasks as files, for the person's machines (the console, the reminders, the local tasks
  // tools): the TaskStore of shared/mcp/lib/brain-tasks.ts on the other side; the rules run there
  if (p === "/api/tasks" && req.method === "GET") {
    const rows = store.db.prepare("select body from docs where deleted = 0 and path like 'tasks/t-%'").all() as {
      body: string;
    }[];
    return json({ tasks: rows.map((r) => r.body) });
  }
  const one = p.match(/^\/api\/tasks\/(t-[\w-]+)$/);
  if (one && req.method === "GET") {
    const d = store.get(`tasks/${one[1]}.md`);
    return d ? json({ task: d.body }) : json({ error: "no such task" }, 404);
  }
  if (one && req.method === "PUT") {
    const body = await req.text();
    if (fromFile(body)?.id !== one[1]) {
      return json({ error: "not a task file, or its id is not the one in the path" }, 400);
    }
    // If-Match: the `updated` of the version the machine changed; a change made since is not lost
    try {
      await tenant.tasks.write(fromFile(body)!, req.headers.get("if-match") ?? undefined);
    } catch (e) {
      if (!(e instanceof StaleError)) throw e;
      return json({ error: "the task changed meanwhile", task: toFile(e.current) }, 409);
    }
    return json({ written: one[1] });
  }
  // the memory read over HTTP, for the console's Brain page (apps/brain/api.ts): only reads
  if (p.startsWith("/api/brain/") && req.method === "GET") {
    const r = await brainApi(toolCtx, u);
    if (r) return json(r.body, r.status);
  }
  // what the machines compare before fetching a backup: it changes with every write, never otherwise
  if (p === "/backup/state" && who.label.startsWith("token:")) {
    const r = store.db.prepare("select count(*) n, max(at) last from revisions").get() as {
      n: number;
      last: string | null;
    };
    return json({ version: `${r.n}:${r.last ?? ""}`, revisions: r.n, last: r.last });
  }
  // the person's brain, sealed with their own backup key: nobody else's copy opens with it
  if (p === "/backup" && who.label.startsWith("token:")) {
    return new Response(await snapshot(store, tenant.file, await users.backupKey(who.user)), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="brain-${new Date().toISOString().slice(0, 10)}.brn"`,
        "cache-control": "no-store",
      },
    });
  }
  return json({ error: "not found" }, 404);
}

const withCors = (r: Response) => {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
};

const server = Deno.serve(
  { port: Number(env("PORT", "8080")), hostname: env("HOST", "0.0.0.0") },
  async (req, info) => {
    // what went wrong stays in the log: a 500 answer carries only this id, which the access line has too
    const id = crypto.randomUUID().slice(0, 8), t0 = performance.now();
    const done = (r: Response) => {
      logRequest(log, req, r.status, performance.now() - t0, id);
      return r;
    };
    try {
      const ip = clientIp(req.headers, (info.remoteAddr as Deno.NetAddr).hostname, IP_HEADER);
      return done(hardened(await handle(capped(req, bodyLimit(new URL(req.url).pathname)), ip), HTTPS));
    } catch (e) {
      if (isTooLarge(e)) return done(hardened(json({ error: "request body too large" }, 413), HTTPS));
      log.error("unhandled error", { id, err: e });
      return done(hardened(json({ error: "internal error", id }, 500), HTTPS));
    }
  },
);
// what expired is deleted at start and then every hour (it is refused on lookup anyway: this keeps
// accounts.db from growing)
const purge = () => {
  try {
    const gone = auth.purge() + users.purge();
    if (gone) log.info("expired rows removed", { rows: gone });
  } catch (e) {
    log.error("purge failed", { error: e });
  }
};
purge();
const purging = setInterval(purge, 3600_000);
// a sealed copy of every database a day into DATA/backups, only with a key to seal it (backups.ts)
const keep = Number(env("BRAIN_BACKUP_KEEP", "7"));
const backups = env("BRAIN_BACKUP_KEY")
  ? startBackups(DATA, env("BRAIN_BACKUP_KEY")!, Number.isInteger(keep) && keep > 0 ? keep : 7, (m) => log.info(m))
  : null;
// stopping (a deploy sends SIGTERM): no new requests, the ones in flight finish, the indexers stop
// and every database is closed, so nothing is cut halfway through a write. Ten seconds at most.
let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info("stopping", { signal });
  clearInterval(purging);
  setTimeout(() => Deno.exit(1), 10_000);
  await server.shutdown();
  await backups?.stop();
  tenants.close();
  accountsDb.close();
  Deno.exit(0);
};
for (const s of ["SIGTERM", "SIGINT"] as const) Deno.addSignalListener(s, () => void stop(s));
log.info("listening", {
  url: URL_,
  data: DATA,
  accounts: users.count(),
  embeddings: `${embedCfg.model} at ${embedCfg.url}`,
});
