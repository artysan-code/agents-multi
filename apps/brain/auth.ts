// auth.ts — who may talk to the brain: its people, through Claude (OAuth) or through their own
// machines (personal tokens).
//
// OAuth 2.1 as claude.ai, the Claude apps and Claude Code expect it from a remote MCP server: the
// protected resource points at this same service as its authorization server; clients register
// themselves (RFC 7591) with a redirect back to Claude only; the authorization code is bound to a
// PKCE S256 challenge; access tokens last an hour, refresh tokens rotate and a reused one revokes
// its whole family. Signing in takes the account id, its passphrase and the current TOTP code
// (users.ts); five wrong attempts from one address lock that account for that address for fifteen
// minutes (the address's rate limit, in main.ts, stops one address trying many ids), and the hashing
// runs two at a time with a short line, so a flood of attempts cannot take the CPU. Every code, token and
// session belongs to one account. Every token is stored as its SHA-256, never as itself.
//
// One more way in goes through the same door: agents-multi on a machine asks for scope `machine`
// and gets, once the person has signed in, a personal token named after it (no expiry, listed and
// revoked on /account like the ones made there) and the account's backup key: its console signs a
// machine in without anything being copied by hand.

import type { DatabaseSync } from "node:sqlite";
import type { Users } from "./users.ts";
import { Gate } from "./guard.ts";
import { migrate, type Migration } from "./migrate.ts";
import { randomToken, same, sha256 } from "./crypto.ts";
import { nodeNameOf } from "../../shared/mcp/lib/nodes.ts";

const SCHEMA = `
create table if not exists users (
  id text primary key, name text not null, language text not null, pass text, totp text, backup text not null,
  admin integer not null default 0, disabled integer not null default 0, created text not null, timezone text);
create table if not exists invites (hash text primary key, user text not null, expires integer not null);
create table if not exists oauth_clients (id text primary key, name text, redirects text not null, created text not null);
create table if not exists oauth_codes (hash text primary key, user text not null, client text not null, redirect text not null, challenge text not null, resource text, scope text, expires integer not null);
create table if not exists tokens (
  hash text primary key, user text not null, kind text not null, client text, name text, family text, expires integer,
  created text not null, used text, revoked integer not null default 0);
create table if not exists sessions (hash text primary key, user text not null, expires integer not null, ends integer not null);
create table if not exists login_failures (user text not null, ip text not null, at integer not null);
`;

/** accounts.db holds the people (users.ts) and their credentials (this file), so one list serves
 *  both: whichever opens the file first brings it up to date. Step 1 is the schema as it was before
 *  versions, and also adapts the older shapes a file may still have. */
export const ACCOUNTS_MIGRATIONS: Migration[] = [
  (db) => {
    const lacks = (t: string, c: string) => {
      const cols = db.prepare(`pragma table_info(${t})`).all() as { name: string }[];
      return cols.length > 0 && !cols.some((x) => x.name === c);
    };
    // accounts from before each had a zone: the service's own, until the person chooses
    if (lacks("users", "timezone")) db.exec("alter table users add column timezone text");
    // codes made before scope was kept: they last a minute, the column is simply added
    if (lacks("oauth_codes", "scope")) db.exec("alter table oauth_codes add column scope text");
    // sessions from before they had an end: signing in again is all it costs
    if (lacks("sessions", "ends")) db.exec("drop table sessions");
    // failures from before they were kept per address: they last fifteen minutes, so they simply go
    if (lacks("login_failures", "ip")) db.exec("drop table login_failures");
    db.exec(SCHEMA);
  }, // pairing a machine with a code (pair.ts, ADR 0014): the codes waiting, and an account's wrong ones
  (db) =>
    db.exec(`
create table if not exists pairings (
  code text primary key, secret text not null unique, name text not null, platform text not null,
  expires integer not null, user text);
create table if not exists pair_failures (user text not null, at integer not null);`),
  // a token's scope (ADR 0013, F2): the personal tokens made before it are a machine's, as are G4's desktop
  // pairings; a server pairing makes a `node` token. A pairing that carries the node's public key is a server's,
  // and keeps the vault key sealed to it until the poll that hands the token over.
  (db) => {
    const cols = (t: string) => (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("tokens").includes("scope")) db.exec("alter table tokens add column scope text");
    for (const c of ["key", "sealed", "scope"]) {
      if (!cols("pairings").includes(c)) db.exec(`alter table pairings add column ${c} text`);
    }
  },
];

export interface AuthConfig {
  url: string;
}
/** Registered OAuth clients kept at most: a client is one Claude connection, a few per person. */
export const MAX_CLIENTS = 1000;
const SESSION_IDLE = 3600_000, SESSION_MAX = 12 * 3600_000;
/** How long the browser keeps the session cookie: the server ends it sooner when it is not used. */
export const SESSION_SECONDS = SESSION_MAX / 1000;
/** What a way in may reach: `brain` a Claude connection (OAuth), `machine` a personal token of the owner's machines
 *  (every one made before F2), `node` a server node's token (ADR 0013), `web` the web app's session. */
export type Scope = "brain" | "machine" | "node" | "web";
/** Who is behind a request: the account, how it came in ("claude:<client>" or "token:<name>"), and its scope. */
export interface Caller {
  user: string;
  label: string;
  scope: Scope;
}

// ---------------------------------------------------------------- what a scope may reach
/** The routes a `node` token may use (ADR 0013, F2): its own turn loop, announce, relays and runs, the jobs (claimed
 *  and reported only when they are its own: the second check is main.ts's, which sees the job), proposing one, the
 *  account's tasks, the MCP endpoint (whose tools tools.ts narrows), the passkeys' public halves (a node checks the
 *  phone's yes against them) and forgetting itself. Anything else is refused. */
export const NODE_ROUTES: [string, RegExp][] = [
  ["PUT", /^\/api\/node$/],
  ["GET", /^\/api\/node\/turns$/],
  ["POST", /^\/api\/turns\/[\w-]{1,64}\/(events|done)$/],
  ["GET", /^\/api\/turns\/[\w-]{1,64}\/audio$/],
  ["GET", /^\/api\/node\/answers$/],
  ["POST", /^\/api\/node\/answers$/],
  ["PUT", /^\/api\/node\/requests$/],
  ["PUT", /^\/api\/node\/runs$/],
  ["POST", /^\/api\/jobs$/],
  ["GET", /^\/api\/jobs\/[\w-]{1,64}$/],
  ["POST", /^\/api\/jobs\/[\w-]{1,64}$/],
  ["GET", /^\/api\/tasks$/],
  ["GET", /^\/api\/tasks\/t-[\w-]+$/],
  ["PUT", /^\/api\/tasks\/t-[\w-]+$/],
  ["GET", /^\/api\/passkeys$/],
  ["DELETE", /^\/api\/nodes\/[^/]{1,64}$/],
  ["*", /^\/mcp$/],
];

/** Pure: whether a scope may use a route at all. Fail-closed: a scope this does not know reaches nothing. The
 *  scopes from before F2 keep what they had; each route still checks the rest (a web session only its WEB_API). */
export function scopeAllows(scope: unknown, method: string, path: string): boolean {
  if (scope === "brain" || scope === "machine" || scope === "web") return true;
  if (scope !== "node") return false;
  return NODE_ROUTES.some(([m, re]) => (m === "*" || m === method) && re.test(path));
}

/** Pure: for a node token past the gate, why a route is still refused, or null: the jobs it reads or acts on are its
 *  own (`jobNode`: the node of the job the path names, null when there is no such job) and it only claims or reports
 *  them (`op`: the body's), and the machine it forgets is itself (`me`: its token's node name). */
export function nodeOwnRefusal(
  r: { method: string; path: string; me: string; op?: unknown; jobNode?: (id: string) => string | null },
): string | null {
  const gone = r.path.match(/^\/api\/nodes\/([^/]+)$/);
  if (gone) {
    let name = "";
    try {
      name = decodeURIComponent(gone[1]);
    } catch { /* not a name */ }
    return name === r.me ? null : "a node forgets only itself";
  }
  const one = r.path.match(/^\/api\/jobs\/([\w-]{1,64})$/);
  if (!one) return null;
  if (r.method === "POST" && r.op !== "claim" && r.op !== "report") {
    return "a node only claims and reports its own jobs";
  }
  const node = r.jobNode?.(one[1]) ?? null;
  return node === null || node === r.me ? null : "not this node's job";
}

/** Pure: why an announce is refused for its token's scope, or null. A server (`headless`) announces with a `node`
 *  token only: a machine's reaches the whole brain, and on a server one leak of it would read it all (ADR 0013,
 *  F2). A desktop keeps its `machine` token. */
export function serverAnnounceRefusal(scope: unknown, body: unknown): string | null {
  const headless = !!body && typeof body === "object" && (body as Record<string, unknown>).headless === true;
  return headless && scope !== "node"
    ? "a server announces with a node token only: agents node pair --server, and revoke this one on /account"
    : null;
}

// ---------------------------------------------------------------- redirects
/** Pure: an http address on this machine, the only kind of redirect allowed besides Claude's. */
function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.username &&
      !u.password;
  } catch {
    return false;
  }
}

/** Pure: where a registered client may be sent back — Claude's own callback, or a loopback port
 *  (Claude Code, which listens on a port it picks each time). */
export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (
      u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname) &&
      u.pathname === "/api/mcp/auth_callback"
    ) return true;
    return isLoopback(uri);
  } catch {
    return false;
  }
}
/** Pure: a redirect matches a registered one, ignoring the port on loopback (RFC 8252). */
export function redirectMatches(registered: string[], uri: string): boolean {
  return registered.some((r) => {
    if (r === uri) return true;
    try {
      const a = new URL(r), b = new URL(uri);
      return a.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(a.hostname) &&
        a.hostname === b.hostname && a.pathname === b.pathname && a.protocol === b.protocol;
    } catch {
      return false;
    }
  });
}

export class Auth {
  constructor(private db: DatabaseSync, private users: Users, private cfg: AuthConfig) {
    migrate(db, ACCOUNTS_MIGRATIONS);
  }

  get resourceMeta() {
    return {
      resource: `${this.cfg.url}/mcp`,
      authorization_servers: [this.cfg.url],
      bearer_methods_supported: ["header"],
      scopes_supported: ["brain"],
    };
  }
  get serverMeta() {
    const u = this.cfg.url;
    return {
      issuer: u,
      authorization_endpoint: `${u}/authorize`,
      token_endpoint: `${u}/token`,
      registration_endpoint: `${u}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["brain", "machine"],
    };
  }
  /** What a request without a valid token is told: where to find how to get one. */
  challenge(): Response {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer resource_metadata="${this.cfg.url}/.well-known/oauth-protected-resource"`,
      },
    });
  }

  /** The account and the way in behind a bearer token, or null; a disabled account has no way in. */
  async caller(req: Request): Promise<Caller | null> {
    const m = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
    if (!m) return null;
    const h = await sha256(m[1]);
    const row = this.db.prepare("select user, kind, client, name, expires, revoked, scope from tokens where hash = ?")
      .get(h) as {
        user: string;
        kind: string;
        client: string | null;
        name: string | null;
        expires: number | null;
        revoked: number;
        scope: string | null;
      } | undefined;
    if (!row || row.revoked || row.kind === "refresh" || (row.expires && row.expires < Date.now())) return null;
    const u = this.users.get(row.user);
    if (!u || u.disabled) return null;
    // "last used" is a courtesy to the owner: written at most every five minutes, not on every request
    const now = Date.now();
    this.db.prepare("update tokens set used = ? where hash = ? and (used is null or used < ?)").run(
      new Date(now).toISOString(),
      h,
      new Date(now - 5 * 60_000).toISOString(),
    );
    if (row.kind === "personal") {
      // a scope this version does not know is kept as it is, and the gate refuses it everything
      return { user: row.user, label: `token:${row.name}`, scope: (row.scope ?? "machine") as Scope };
    }
    const c = this.db.prepare("select name from oauth_clients where id = ?").get(row.client) as
      | { name: string }
      | undefined;
    return { user: row.user, label: `claude:${c?.name ?? "client"}`, scope: "brain" };
  }

  // ------------------------------------------------------------ the door
  private hashing = new Gate(2, 32);
  /** Five wrong attempts on an account from one address close it to that address for fifteen
   *  minutes, so nobody can lock its owner out from elsewhere; an id that does not exist counts the
   *  same way, so the answers say nothing about which ids do. */
  private locked(user: string, ip: string): boolean {
    this.db.prepare("delete from login_failures where at < ?").run(Date.now() - 15 * 60_000);
    return (this.db.prepare("select count(*) n from login_failures where user = ? and ip = ?").get(user, ip) as {
      n: number;
    }).n >= 5;
  }
  /** The account id, its passphrase and TOTP code, from an address; a wrong set counts toward that
   *  account's lock for that address. `busy` when too many attempts are already waiting. */
  async signIn(
    user: string,
    passphrase: string,
    code: string,
    ip: string,
  ): Promise<"ok" | "wrong" | "locked" | "busy"> {
    const id = user.trim().toLowerCase().slice(0, 40);
    if (this.locked(id, ip)) return "locked";
    const ok = await this.hashing.run(() => this.users.verify(id, passphrase, code));
    if (ok === null) return "busy";
    if (ok) {
      this.db.prepare("delete from login_failures where user = ? and ip = ?").run(id, ip);
      return "ok";
    }
    this.db.prepare("insert into login_failures (user, ip, at) values (?, ?, ?)").run(id, ip, Date.now());
    return "wrong";
  }

  // ------------------------------------------------------------ OAuth
  /** Anyone may register a client (RFC 7591: that is how Claude connects), so the ones nobody uses
   *  go: a client that never got a code or a token after an hour (a real one authorises within
   *  minutes), and one with no live token after
   *  ninety days. Past MAX_CLIENTS still in use, registration waits. */
  private pruneClients(now: number): number {
    const hour = new Date(now - 3600_000).toISOString(), quarter = new Date(now - 90 * 86_400_000).toISOString();
    const unused = this.db.prepare(
      `delete from oauth_clients where created < ? and not exists (select 1 from tokens t where t.client = oauth_clients.id)
        and not exists (select 1 from oauth_codes c where c.client = oauth_clients.id)`,
    ).run(hour);
    const idle = this.db.prepare(
      `delete from oauth_clients where created < ? and not exists (select 1 from tokens t where t.client = oauth_clients.id
        and t.revoked = 0 and (t.expires is null or t.expires > ?))`,
    ).run(quarter, now);
    return Number(unused.changes) + Number(idle.changes);
  }

  /** Rows nothing will read again: spent codes, expired sessions, old login failures, unused clients.
   *  Every one is already refused or ignored when it is looked up; this only keeps the file from
   *  growing. Tokens go ninety days after they expire, not at once: pruneClients counts them to tell
   *  a client in use from one nobody uses, and by then that rule has settled the client either way.
   *  Returns how many rows went. */
  purge(now = Date.now()): number {
    const n = (r: { changes: number | bigint }) => Number(r.changes);
    let gone = this.pruneClients(now);
    gone += n(this.db.prepare("delete from oauth_codes where expires < ?").run(now));
    gone += n(this.db.prepare("delete from tokens where expires < ?").run(now - 90 * 86_400_000));
    gone += n(this.db.prepare("delete from sessions where expires < ?").run(now));
    gone += n(this.db.prepare("delete from login_failures where at < ?").run(now - 15 * 60_000));
    gone += n(this.db.prepare("delete from pairings where expires < ?").run(now));
    gone += n(this.db.prepare("delete from pair_failures where at < ?").run(now - 15 * 60_000));
    return gone;
  }

  register(
    body: { redirect_uris?: unknown; client_name?: unknown },
    now = Date.now(),
  ): { status: number; json: unknown } {
    this.pruneClients(now);
    if ((this.db.prepare("select count(*) n from oauth_clients").get() as { n: number }).n >= MAX_CLIENTS) {
      return {
        status: 503,
        json: { error: "temporarily_unavailable", error_description: "too many registered clients" },
      };
    }
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every(redirectAllowed)) {
      return {
        status: 400,
        json: { error: "invalid_redirect_uri", error_description: "only Claude's callback or a loopback address" },
      };
    }
    const id = randomToken(16), name = String(body.client_name ?? "Claude").slice(0, 80);
    this.db.prepare("insert into oauth_clients (id, name, redirects, created) values (?, ?, ?, ?)").run(
      id,
      name,
      JSON.stringify(uris),
      new Date(now).toISOString(),
    );
    return {
      status: 201,
      json: {
        client_id: id,
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    };
  }

  client(id: string): { id: string; name: string; redirects: string[] } | null {
    const c = this.db.prepare("select id, name, redirects from oauth_clients where id = ?").get(id) as {
      id: string;
      name: string;
      redirects: string;
    } | undefined;
    return c ? { ...c, redirects: JSON.parse(c.redirects) } : null;
  }

  /** Checks an authorization request; the message is what the page shows when it is not valid. */
  checkAuthorize(
    p: URLSearchParams,
  ): { ok: true; client: { id: string; name: string }; redirect: string; machine: boolean } | {
    ok: false;
    message: string;
  } {
    const c = this.client(p.get("client_id") ?? "");
    if (!c) return { ok: false, message: "unknown client" };
    const redirect = p.get("redirect_uri") ?? "";
    if (!redirectMatches(c.redirects, redirect)) return { ok: false, message: "redirect not registered" };
    if (p.get("response_type") !== "code") return { ok: false, message: "response_type must be code" };
    if (p.get("code_challenge_method") !== "S256" || !/^[\w-]{43,128}$/.test(p.get("code_challenge") ?? "")) {
      return { ok: false, message: "PKCE S256 required" };
    }
    const res = p.get("resource");
    if (res && res !== `${this.cfg.url}/mcp` && res !== this.cfg.url) return { ok: false, message: "unknown resource" };
    const scope = p.get("scope") ?? "";
    if (!["", "brain", "machine"].includes(scope)) return { ok: false, message: "unknown scope" };
    // a token that does not expire goes only to a program on the person's own machine
    if (scope === "machine" && !isLoopback(redirect)) {
      return { ok: false, message: "scope machine is for a loopback redirect" };
    }
    return { ok: true, client: c, redirect, machine: scope === "machine" };
  }

  /** A code for the account that just signed in: the tokens it turns into are that account's. */
  async issueCode(p: URLSearchParams, user: string): Promise<string> {
    const code = randomToken();
    this.db.prepare(
      "insert into oauth_codes (hash, user, client, redirect, challenge, resource, scope, expires) values (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .run(
        await sha256(code),
        user,
        p.get("client_id"),
        p.get("redirect_uri"),
        p.get("code_challenge"),
        p.get("resource"),
        p.get("scope"),
        Date.now() + 60_000,
      );
    const u = new URL(p.get("redirect_uri")!);
    u.searchParams.set("code", code);
    if (p.get("state")) u.searchParams.set("state", p.get("state")!);
    u.searchParams.set("iss", this.cfg.url);
    return u.toString();
  }

  private async pair(user: string, client: string, family = randomToken(12)) {
    const access = randomToken(), refresh = randomToken(), now = new Date().toISOString();
    const ins = this.db.prepare(
      "insert into tokens (hash, user, kind, client, family, expires, created) values (?, ?, ?, ?, ?, ?, ?)",
    );
    ins.run(await sha256(access), user, "access", client, family, Date.now() + 3600_000, now);
    ins.run(await sha256(refresh), user, "refresh", client, family, Date.now() + 30 * 86400_000, now);
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "brain" };
  }

  async token(f: URLSearchParams): Promise<{ status: number; json: unknown }> {
    const bad = (error: string, d?: string) => ({
      status: 400,
      json: { error, ...(d ? { error_description: d } : {}) },
    });
    if (f.get("grant_type") === "authorization_code") {
      const h = await sha256(f.get("code") ?? "");
      const c = this.db.prepare("select * from oauth_codes where hash = ?").get(h) as {
        user: string;
        client: string;
        redirect: string;
        challenge: string;
        scope: string | null;
        expires: number;
      } | undefined;
      this.db.prepare("delete from oauth_codes where hash = ? or expires < ?").run(h, Date.now()); // one use only
      if (!c || c.expires < Date.now()) return bad("invalid_grant", "code expired or used");
      if (c.client !== f.get("client_id") || c.redirect !== f.get("redirect_uri")) {
        return bad("invalid_grant", "client or redirect differ");
      }
      if (!same(await sha256(f.get("code_verifier") ?? ""), c.challenge)) {
        return bad("invalid_grant", "PKCE verifier does not match");
      }
      if (c.scope === "machine") {
        const token = await this.createPersonal(c.user, this.client(c.client)?.name ?? "machine");
        return {
          status: 200,
          json: {
            access_token: token,
            token_type: "Bearer",
            scope: "machine",
            account: c.user,
            backup_key: await this.users.backupKey(c.user),
          },
        };
      }
      return { status: 200, json: await this.pair(c.user, c.client) };
    }
    if (f.get("grant_type") === "refresh_token") {
      const h = await sha256(f.get("refresh_token") ?? "");
      const r = this.db.prepare(
        "select user, client, family, expires, revoked from tokens where hash = ? and kind = 'refresh'",
      ).get(h) as { user: string; client: string; family: string; expires: number; revoked: number } | undefined;
      if (!r || r.expires < Date.now()) return bad("invalid_grant");
      if (r.revoked) { // a refresh token used twice: someone else has a copy, so the whole family goes
        this.db.prepare("update tokens set revoked = 1 where family = ?").run(r.family);
        return bad("invalid_grant", "token reused");
      }
      if (f.get("client_id") && f.get("client_id") !== r.client) return bad("invalid_grant");
      const u = this.users.get(r.user);
      if (!u || u.disabled) return bad("invalid_grant", "account disabled");
      this.db.prepare("update tokens set revoked = 1 where hash = ?").run(h);
      return { status: 200, json: await this.pair(r.user, r.client, r.family) };
    }
    return bad("unsupported_grant_type");
  }

  // ------------------------------------------------------------ the web pages: sessions and personal tokens
  /** A session on the web pages (account, board): it lasts an hour from its last use, twelve at most. */
  async newSession(user: string, now = Date.now()): Promise<string> {
    const s = randomToken();
    this.db.prepare("delete from sessions where expires < ?").run(now);
    this.db.prepare("insert into sessions (hash, user, expires, ends) values (?, ?, ?, ?)").run(
      await sha256(s),
      user,
      Math.min(now + SESSION_IDLE, now + SESSION_MAX),
      now + SESSION_MAX,
    );
    return s;
  }
  /** The account signed in on the web pages, or null; each use moves the hour on. */
  async session(req: Request, now = Date.now()): Promise<string | null> {
    const s = req.headers.get("cookie")?.match(/(?:^|;\s*)brain_session=([\w-]+)/)?.[1];
    if (!s) return null;
    const h = await sha256(s);
    const r = this.db.prepare("select user, expires, ends from sessions where hash = ?").get(h) as {
      user: string;
      expires: number;
      ends: number;
    } | undefined;
    if (!r || r.expires < now) return null;
    const u = this.users.get(r.user);
    if (!u || u.disabled) return null;
    this.db.prepare("update sessions set expires = ? where hash = ?").run(Math.min(now + SESSION_IDLE, r.ends), h);
    return r.user;
  }
  async endSession(req: Request) {
    const s = req.headers.get("cookie")?.match(/(?:^|;\s*)brain_session=([\w-]+)/)?.[1];
    if (s) this.db.prepare("delete from sessions where hash = ?").run(await sha256(s));
  }
  async createPersonal(user: string, name: string, scope: "machine" | "node" = "machine"): Promise<string> {
    const t = `brain_${randomToken()}`;
    this.db.prepare("insert into tokens (hash, user, kind, name, created, scope) values (?, ?, 'personal', ?, ?, ?)")
      .run(await sha256(t), user, name.slice(0, 60), new Date().toISOString(), scope);
    return t;
  }
  personalTokens(user: string): { name: string; created: string; used: string | null; hash: string }[] {
    return this.db.prepare(
      "select name, created, used, hash from tokens where user = ? and kind = 'personal' and revoked = 0 order by created",
    ).all(user) as never;
  }
  connections(user: string): { name: string; created: string; used: string | null }[] {
    return this.db.prepare(
      `select c.name, min(t.created) created, max(t.used) used from tokens t join oauth_clients c on c.id = t.client
       where t.user = ? and t.kind = 'access' and t.revoked = 0 group by t.family order by used desc limit 20`,
    ).all(user) as never;
  }
  /** A personal token of this account revoked; another account's is out of reach. */
  revoke(user: string, hash: string) {
    this.db.prepare("update tokens set revoked = 1 where hash = ? and user = ?").run(hash, user);
  }
  /** The personal tokens of this account named after a node (the pairing and `agents node login` name a token
   *  after its machine) revoked; how many. */
  revokeNode(user: string, node: string): number {
    const rows = this.db.prepare("select hash, name from tokens where user = ? and kind = 'personal' and revoked = 0")
      .all(user) as { hash: string; name: string | null }[];
    let n = 0;
    for (const r of rows) {
      if (r.name && nodeNameOf(r.name) === node) {
        this.db.prepare("update tokens set revoked = 1 where hash = ?").run(r.hash);
        n++;
      }
    }
    return n;
  }
  revokeAllClaude(user: string) {
    this.db.prepare("update tokens set revoked = 1 where user = ? and kind in ('access', 'refresh')").run(user);
  }
  /** Everything an account holds here cut off: its tokens and its sessions. */
  revokeAll(user: string) {
    this.db.prepare("update tokens set revoked = 1 where user = ?").run(user);
    this.db.prepare("delete from sessions where user = ?").run(user);
  }

  /** An account's failed sign-ins forgotten, from every address: its lock lifted before the fifteen minutes. */
  unlock(user: string) {
    this.db.prepare("delete from login_failures where user = ?").run(user);
    this.db.prepare("delete from pair_failures where user = ?").run(user);
  }
  /** Everything of a deleted account removed: tokens, codes, sessions, failed attempts. */
  forget(user: string) {
    for (const t of ["tokens", "oauth_codes", "sessions", "login_failures", "pair_failures", "pairings"]) {
      this.db.prepare(`delete from ${t} where user = ?`).run(user);
    }
  }

  /** The clients and live tokens of the database the service kept before it served several people,
   *  carried over to the account they belonged to: Claude's connections and the machines' tokens
   *  keep working through the change. Tokens are hashes there and here: nothing is revealed. */
  adopt(old: DatabaseSync, user: string): number {
    const has = (t: string) => !!old.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
    if (!has("tokens") || !has("oauth_clients")) return 0;
    for (
      const c of old.prepare("select id, name, redirects, created from oauth_clients").all() as Record<string, string>[]
    ) {
      this.db.prepare("insert or ignore into oauth_clients (id, name, redirects, created) values (?, ?, ?, ?)").run(
        c.id,
        c.name,
        c.redirects,
        c.created,
      );
    }
    let n = 0;
    for (
      const t of old.prepare("select * from tokens where revoked = 0 and (expires is null or expires > ?)").all(
        Date.now(),
      ) as Record<string, string | number | null>[]
    ) {
      this.db.prepare(
        "insert or ignore into tokens (hash, user, kind, client, name, family, expires, created, used, revoked) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
      )
        .run(t.hash, user, t.kind, t.client, t.name, t.family, t.expires, t.created, t.used);
      n++;
    }
    return n;
  }
}
