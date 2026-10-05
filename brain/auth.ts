// auth.ts — who may talk to the brain: its people, through Claude (OAuth) or through their own
// machines (personal tokens).
//
// OAuth 2.1 as claude.ai, the Claude apps and Claude Code expect it from a remote MCP server: the
// protected resource points at this same service as its authorization server; clients register
// themselves (RFC 7591) with a redirect back to Claude only; the authorization code is bound to a
// PKCE S256 challenge; access tokens last an hour, refresh tokens rotate and a reused one revokes
// its whole family. Signing in takes the account id, its passphrase and the current TOTP code
// (users.ts); five wrong attempts lock that account for fifteen minutes. Every code, token and
// session belongs to one account. Every token is stored as its SHA-256, never as itself.
//
// One more way in goes through the same door: claude-multi on a machine asks for scope `machine`
// and gets, once the person has signed in, a personal token named after it (no expiry, listed and
// revoked on /account like the ones made there) and the account's backup key: its console signs a
// machine in without anything being copied by hand.

import type { DatabaseSync } from "node:sqlite";
import type { Users } from "./users.ts";

const SCHEMA = `
create table if not exists oauth_clients (id text primary key, name text, redirects text not null, created text not null);
create table if not exists oauth_codes (hash text primary key, user text not null, client text not null, redirect text not null, challenge text not null, resource text, expires integer not null);
create table if not exists tokens (
  hash text primary key, user text not null, kind text not null, client text, name text, family text, expires integer,
  created text not null, used text, revoked integer not null default 0);
create table if not exists sessions (hash text primary key, user text not null, expires integer not null, ends integer not null);
create table if not exists login_failures (user text not null, at integer not null);
`;

export interface AuthConfig { url: string }
const SESSION_IDLE = 3600_000, SESSION_MAX = 12 * 3600_000;
/** How long the browser keeps the session cookie: the server ends it sooner when it is not used. */
export const SESSION_SECONDS = SESSION_MAX / 1000;
/** Who is behind a request: the account, and how it came in ("claude:<client>" or "token:<name>"). */
export interface Caller { user: string; label: string }

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}
/** Pure-ish: equal strings in time that does not depend on where they differ. */
export function same(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

// ---------------------------------------------------------------- TOTP (RFC 6238: SHA-1, 30 s, 6 digits)
export function base32Decode(s: string): Uint8Array<ArrayBuffer> {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = A.indexOf(c);
    if (i < 0) throw new Error("not base32");
    val = (val << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
export function base32Encode(b: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0, out = "";
  for (const x of b) {
    val = (val << 8) | x;
    bits += 8;
    while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) out += A[(val << (5 - bits)) & 31];
  return out;
}
export async function totp(secret: string, at = Date.now(), step = 30): Promise<string> {
  const counter = Math.floor(at / 1000 / step);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000;
  return String(n).padStart(6, "0");
}
/** The code of this window or of the one either side: a phone's clock is seldom exact. */
export async function totpOk(secret: string, code: string, at = Date.now()): Promise<boolean> {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  for (const d of [0, -30_000, 30_000]) if (same(await totp(secret, at + d), c)) return true;
  return false;
}

// ---------------------------------------------------------------- redirects
/** Pure: an http address on this machine, the only kind of redirect allowed besides Claude's. */
function isLoopback(uri: string): boolean {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.username && !u.password;
  } catch { return false; }
}

/** Pure: where a registered client may be sent back — Claude's own callback, or a loopback port
 *  (Claude Code, which listens on a port it picks each time). */
export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname) && u.pathname === "/api/mcp/auth_callback") return true;
    return isLoopback(uri);
  } catch { return false; }
}
/** Pure: a redirect matches a registered one, ignoring the port on loopback (RFC 8252). */
export function redirectMatches(registered: string[], uri: string): boolean {
  return registered.some((r) => {
    if (r === uri) return true;
    try {
      const a = new URL(r), b = new URL(uri);
      return a.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.protocol === b.protocol;
    } catch { return false; }
  });
}

export class Auth {
  constructor(private db: DatabaseSync, private users: Users, private cfg: AuthConfig) {
    db.exec(SCHEMA);
    // codes made before scope was kept: they last a minute, the column is simply added
    if (!(db.prepare("pragma table_info(oauth_codes)").all() as { name: string }[]).some((c) => c.name === "scope")) db.exec("alter table oauth_codes add column scope text");
    // sessions from before they had an end: signing in again is all it costs
    if (!(db.prepare("pragma table_info(sessions)").all() as { name: string }[]).some((c) => c.name === "ends")) {
      db.exec("drop table sessions; create table sessions (hash text primary key, user text not null, expires integer not null, ends integer not null);");
    }
  }

  get resourceMeta() {
    return { resource: `${this.cfg.url}/mcp`, authorization_servers: [this.cfg.url], bearer_methods_supported: ["header"], scopes_supported: ["brain"] };
  }
  get serverMeta() {
    const u = this.cfg.url;
    return {
      issuer: u, authorization_endpoint: `${u}/authorize`, token_endpoint: `${u}/token`, registration_endpoint: `${u}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["brain", "machine"],
    };
  }
  /** What a request without a valid token is told: where to find how to get one. */
  challenge(): Response {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${this.cfg.url}/.well-known/oauth-protected-resource"` },
    });
  }

  /** The account and the way in behind a bearer token, or null; a disabled account has no way in. */
  async caller(req: Request): Promise<Caller | null> {
    const m = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
    if (!m) return null;
    const h = await sha256(m[1]);
    const row = this.db.prepare("select user, kind, client, name, expires, revoked from tokens where hash = ?").get(h) as
      { user: string; kind: string; client: string | null; name: string | null; expires: number | null; revoked: number } | undefined;
    if (!row || row.revoked || row.kind === "refresh" || (row.expires && row.expires < Date.now())) return null;
    const u = this.users.get(row.user);
    if (!u || u.disabled) return null;
    this.db.prepare("update tokens set used = ? where hash = ?").run(new Date().toISOString(), h);
    if (row.kind === "personal") return { user: row.user, label: `token:${row.name}` };
    const c = this.db.prepare("select name from oauth_clients where id = ?").get(row.client) as { name: string } | undefined;
    return { user: row.user, label: `claude:${c?.name ?? "client"}` };
  }

  // ------------------------------------------------------------ the door
  /** Five wrong attempts on an account close it for fifteen minutes; an id that does not exist
   *  counts the same way, so the answers say nothing about which ids do. */
  private locked(user: string): boolean {
    this.db.prepare("delete from login_failures where at < ?").run(Date.now() - 15 * 60_000);
    return (this.db.prepare("select count(*) n from login_failures where user = ?").get(user) as { n: number }).n >= 5;
  }
  /** The account id, its passphrase and TOTP code; a wrong set counts toward that account's lock. */
  async signIn(user: string, passphrase: string, code: string): Promise<"ok" | "wrong" | "locked"> {
    const id = user.trim().toLowerCase().slice(0, 40);
    if (this.locked(id)) return "locked";
    if (await this.users.verify(id, passphrase, code)) { this.db.prepare("delete from login_failures where user = ?").run(id); return "ok"; }
    this.db.prepare("insert into login_failures (user, at) values (?, ?)").run(id, Date.now());
    return "wrong";
  }

  // ------------------------------------------------------------ OAuth
  register(body: { redirect_uris?: unknown; client_name?: unknown }): { status: number; json: unknown } {
    const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!uris.length || !uris.every(redirectAllowed)) return { status: 400, json: { error: "invalid_redirect_uri", error_description: "only Claude's callback or a loopback address" } };
    const id = randomToken(16), name = String(body.client_name ?? "Claude").slice(0, 80);
    this.db.prepare("insert into oauth_clients (id, name, redirects, created) values (?, ?, ?, ?)").run(id, name, JSON.stringify(uris), new Date().toISOString());
    return { status: 201, json: { client_id: id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] } };
  }

  client(id: string): { id: string; name: string; redirects: string[] } | null {
    const c = this.db.prepare("select id, name, redirects from oauth_clients where id = ?").get(id) as { id: string; name: string; redirects: string } | undefined;
    return c ? { ...c, redirects: JSON.parse(c.redirects) } : null;
  }

  /** Checks an authorization request; the message is what the page shows when it is not valid. */
  checkAuthorize(p: URLSearchParams): { ok: true; client: { id: string; name: string }; redirect: string; machine: boolean } | { ok: false; message: string } {
    const c = this.client(p.get("client_id") ?? "");
    if (!c) return { ok: false, message: "unknown client" };
    const redirect = p.get("redirect_uri") ?? "";
    if (!redirectMatches(c.redirects, redirect)) return { ok: false, message: "redirect not registered" };
    if (p.get("response_type") !== "code") return { ok: false, message: "response_type must be code" };
    if (p.get("code_challenge_method") !== "S256" || !/^[\w-]{43,128}$/.test(p.get("code_challenge") ?? "")) return { ok: false, message: "PKCE S256 required" };
    const res = p.get("resource");
    if (res && res !== `${this.cfg.url}/mcp` && res !== this.cfg.url) return { ok: false, message: "unknown resource" };
    const scope = p.get("scope") ?? "";
    if (!["", "brain", "machine"].includes(scope)) return { ok: false, message: "unknown scope" };
    // a token that does not expire goes only to a program on the person's own machine
    if (scope === "machine" && !isLoopback(redirect)) return { ok: false, message: "scope machine is for a loopback redirect" };
    return { ok: true, client: c, redirect, machine: scope === "machine" };
  }

  /** A code for the account that just signed in: the tokens it turns into are that account's. */
  async issueCode(p: URLSearchParams, user: string): Promise<string> {
    const code = randomToken();
    this.db.prepare("insert into oauth_codes (hash, user, client, redirect, challenge, resource, scope, expires) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(await sha256(code), user, p.get("client_id"), p.get("redirect_uri"), p.get("code_challenge"), p.get("resource"), p.get("scope"), Date.now() + 60_000);
    const u = new URL(p.get("redirect_uri")!);
    u.searchParams.set("code", code);
    if (p.get("state")) u.searchParams.set("state", p.get("state")!);
    u.searchParams.set("iss", this.cfg.url);
    return u.toString();
  }

  private async pair(user: string, client: string, family = randomToken(12)) {
    const access = randomToken(), refresh = randomToken(), now = new Date().toISOString();
    const ins = this.db.prepare("insert into tokens (hash, user, kind, client, family, expires, created) values (?, ?, ?, ?, ?, ?, ?)");
    ins.run(await sha256(access), user, "access", client, family, Date.now() + 3600_000, now);
    ins.run(await sha256(refresh), user, "refresh", client, family, Date.now() + 30 * 86400_000, now);
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "brain" };
  }

  async token(f: URLSearchParams): Promise<{ status: number; json: unknown }> {
    const bad = (error: string, d?: string) => ({ status: 400, json: { error, ...(d ? { error_description: d } : {}) } });
    if (f.get("grant_type") === "authorization_code") {
      const h = await sha256(f.get("code") ?? "");
      const c = this.db.prepare("select * from oauth_codes where hash = ?").get(h) as { user: string; client: string; redirect: string; challenge: string; scope: string | null; expires: number } | undefined;
      this.db.prepare("delete from oauth_codes where hash = ? or expires < ?").run(h, Date.now()); // one use only
      if (!c || c.expires < Date.now()) return bad("invalid_grant", "code expired or used");
      if (c.client !== f.get("client_id") || c.redirect !== f.get("redirect_uri")) return bad("invalid_grant", "client or redirect differ");
      if (!same(await sha256(f.get("code_verifier") ?? ""), c.challenge)) return bad("invalid_grant", "PKCE verifier does not match");
      if (c.scope === "machine") {
        const token = await this.createPersonal(c.user, this.client(c.client)?.name ?? "machine");
        return { status: 200, json: { access_token: token, token_type: "Bearer", scope: "machine", account: c.user, backup_key: await this.users.backupKey(c.user) } };
      }
      return { status: 200, json: await this.pair(c.user, c.client) };
    }
    if (f.get("grant_type") === "refresh_token") {
      const h = await sha256(f.get("refresh_token") ?? "");
      const r = this.db.prepare("select user, client, family, expires, revoked from tokens where hash = ? and kind = 'refresh'").get(h) as
        { user: string; client: string; family: string; expires: number; revoked: number } | undefined;
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
    this.db.prepare("insert into sessions (hash, user, expires, ends) values (?, ?, ?, ?)").run(await sha256(s), user, Math.min(now + SESSION_IDLE, now + SESSION_MAX), now + SESSION_MAX);
    return s;
  }
  /** The account signed in on the web pages, or null; each use moves the hour on. */
  async session(req: Request, now = Date.now()): Promise<string | null> {
    const s = req.headers.get("cookie")?.match(/(?:^|;\s*)brain_session=([\w-]+)/)?.[1];
    if (!s) return null;
    const h = await sha256(s);
    const r = this.db.prepare("select user, expires, ends from sessions where hash = ?").get(h) as { user: string; expires: number; ends: number } | undefined;
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
  async createPersonal(user: string, name: string): Promise<string> {
    const t = `brain_${randomToken()}`;
    this.db.prepare("insert into tokens (hash, user, kind, name, created) values (?, ?, 'personal', ?, ?)").run(await sha256(t), user, name.slice(0, 60), new Date().toISOString());
    return t;
  }
  personalTokens(user: string): { name: string; created: string; used: string | null; hash: string }[] {
    return this.db.prepare("select name, created, used, hash from tokens where user = ? and kind = 'personal' and revoked = 0 order by created").all(user) as never;
  }
  connections(user: string): { name: string; created: string; used: string | null }[] {
    return this.db.prepare(
      `select c.name, min(t.created) created, max(t.used) used from tokens t join oauth_clients c on c.id = t.client
       where t.user = ? and t.kind = 'access' and t.revoked = 0 group by t.family order by used desc limit 20`,
    ).all(user) as never;
  }
  /** A personal token of this account revoked; another account's is out of reach. */
  revoke(user: string, hash: string) { this.db.prepare("update tokens set revoked = 1 where hash = ? and user = ?").run(hash, user); }
  revokeAllClaude(user: string) { this.db.prepare("update tokens set revoked = 1 where user = ? and kind in ('access', 'refresh')").run(user); }
  /** Everything an account holds here cut off: its tokens and its sessions. */
  revokeAll(user: string) {
    this.db.prepare("update tokens set revoked = 1 where user = ?").run(user);
    this.db.prepare("delete from sessions where user = ?").run(user);
  }

  /** The clients and live tokens of the database the service kept before it served several people,
   *  carried over to the account they belonged to: Claude's connections and the machines' tokens
   *  keep working through the change. Tokens are hashes there and here: nothing is revealed. */
  adopt(old: DatabaseSync, user: string): number {
    const has = (t: string) => !!old.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(t);
    if (!has("tokens") || !has("oauth_clients")) return 0;
    for (const c of old.prepare("select id, name, redirects, created from oauth_clients").all() as Record<string, string>[]) {
      this.db.prepare("insert or ignore into oauth_clients (id, name, redirects, created) values (?, ?, ?, ?)").run(c.id, c.name, c.redirects, c.created);
    }
    let n = 0;
    for (const t of old.prepare("select * from tokens where revoked = 0 and (expires is null or expires > ?)").all(Date.now()) as Record<string, string | number | null>[]) {
      this.db.prepare("insert or ignore into tokens (hash, user, kind, client, name, family, expires, created, used, revoked) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)")
        .run(t.hash, user, t.kind, t.client, t.name, t.family, t.expires, t.created, t.used);
      n++;
    }
    return n;
  }
}
