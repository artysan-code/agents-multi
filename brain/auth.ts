// auth.ts — who may talk to the brain: its owner, through Claude (OAuth) or through their own machines
// (personal tokens).
//
// OAuth 2.1 as claude.ai, the Claude apps and Claude Code expect it from a remote MCP server: the
// protected resource points at this same service as its authorization server; clients register
// themselves (RFC 7591) with a redirect back to Claude only; the authorization code is bound to a
// PKCE S256 challenge; access tokens last an hour, refresh tokens rotate and a reused one revokes
// its whole family. Signing in takes the passphrase and the current TOTP code; five wrong attempts
// lock the door for fifteen minutes. Every token is stored as its SHA-256, never as itself.

import type { DatabaseSync } from "node:sqlite";

const SCHEMA = `
create table if not exists oauth_clients (id text primary key, name text, redirects text not null, created text not null);
create table if not exists oauth_codes (hash text primary key, client text not null, redirect text not null, challenge text not null, resource text, expires integer not null);
create table if not exists tokens (
  hash text primary key, kind text not null, client text, name text, family text, expires integer,
  created text not null, used text, revoked integer not null default 0);
create table if not exists sessions (hash text primary key, expires integer not null);
create table if not exists login_failures (at integer not null);
`;

export interface AuthConfig { url: string; passphrase: string; totpSecret: string | null }

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
/** Pure: where a registered client may be sent back — Claude's own callback, or a loopback port
 *  (Claude Code, which listens on a port it picks each time). */
export function redirectAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname) && u.pathname === "/api/mcp/auth_callback") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && !u.username && !u.password;
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
  constructor(private db: DatabaseSync, private cfg: AuthConfig) {
    db.exec(SCHEMA);
  }

  get resourceMeta() {
    return { resource: `${this.cfg.url}/mcp`, authorization_servers: [this.cfg.url], bearer_methods_supported: ["header"], scopes_supported: ["brain"] };
  }
  get serverMeta() {
    const u = this.cfg.url;
    return {
      issuer: u, authorization_endpoint: `${u}/authorize`, token_endpoint: `${u}/token`, registration_endpoint: `${u}/register`,
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["brain"],
    };
  }
  /** What a request without a valid token is told: where to find how to get one. */
  challenge(): Response {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": `Bearer resource_metadata="${this.cfg.url}/.well-known/oauth-protected-resource"` },
    });
  }

  /** The caller behind a bearer token: "claude:<client name>" or "token:<name>", or null. */
  async caller(req: Request): Promise<string | null> {
    const m = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
    if (!m) return null;
    const row = this.db.prepare("select kind, client, name, expires, revoked from tokens where hash = ?").get(await sha256(m[1])) as
      { kind: string; client: string | null; name: string | null; expires: number | null; revoked: number } | undefined;
    if (!row || row.revoked || row.kind === "refresh" || (row.expires && row.expires < Date.now())) return null;
    this.db.prepare("update tokens set used = ? where hash = ?").run(new Date().toISOString(), await sha256(m[1]));
    if (row.kind === "personal") return `token:${row.name}`;
    const c = this.db.prepare("select name from oauth_clients where id = ?").get(row.client) as { name: string } | undefined;
    return `claude:${c?.name ?? "client"}`;
  }

  // ------------------------------------------------------------ the door
  private locked(): boolean {
    const since = Date.now() - 15 * 60_000;
    this.db.prepare("delete from login_failures where at < ?").run(since);
    return (this.db.prepare("select count(*) n from login_failures").get() as { n: number }).n >= 5;
  }
  /** The passphrase and the TOTP code; a wrong pair counts toward the lock. */
  async signIn(passphrase: string, code: string): Promise<"ok" | "wrong" | "locked"> {
    if (this.locked()) return "locked";
    const ok = same(passphrase, this.cfg.passphrase) && (!this.cfg.totpSecret || await totpOk(this.cfg.totpSecret, code));
    if (ok) { this.db.prepare("delete from login_failures").run(); return "ok"; }
    this.db.prepare("insert into login_failures (at) values (?)").run(Date.now());
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
  checkAuthorize(p: URLSearchParams): { ok: true; client: { id: string; name: string }; redirect: string } | { ok: false; message: string } {
    const c = this.client(p.get("client_id") ?? "");
    if (!c) return { ok: false, message: "unknown client" };
    const redirect = p.get("redirect_uri") ?? "";
    if (!redirectMatches(c.redirects, redirect)) return { ok: false, message: "redirect not registered" };
    if (p.get("response_type") !== "code") return { ok: false, message: "response_type must be code" };
    if (p.get("code_challenge_method") !== "S256" || !/^[\w-]{43,128}$/.test(p.get("code_challenge") ?? "")) return { ok: false, message: "PKCE S256 required" };
    const res = p.get("resource");
    if (res && res !== `${this.cfg.url}/mcp` && res !== this.cfg.url) return { ok: false, message: "unknown resource" };
    return { ok: true, client: c, redirect };
  }

  async issueCode(p: URLSearchParams): Promise<string> {
    const code = randomToken();
    this.db.prepare("insert into oauth_codes (hash, client, redirect, challenge, resource, expires) values (?, ?, ?, ?, ?, ?)")
      .run(await sha256(code), p.get("client_id"), p.get("redirect_uri"), p.get("code_challenge"), p.get("resource"), Date.now() + 60_000);
    const u = new URL(p.get("redirect_uri")!);
    u.searchParams.set("code", code);
    if (p.get("state")) u.searchParams.set("state", p.get("state")!);
    u.searchParams.set("iss", this.cfg.url);
    return u.toString();
  }

  private async pair(client: string, family = randomToken(12)) {
    const access = randomToken(), refresh = randomToken(), now = new Date().toISOString();
    this.db.prepare("insert into tokens (hash, kind, client, family, expires, created) values (?, 'access', ?, ?, ?, ?)").run(await sha256(access), client, family, Date.now() + 3600_000, now);
    this.db.prepare("insert into tokens (hash, kind, client, family, expires, created) values (?, 'refresh', ?, ?, ?, ?)").run(await sha256(refresh), client, family, Date.now() + 30 * 86400_000, now);
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: "brain" };
  }

  async token(f: URLSearchParams): Promise<{ status: number; json: unknown }> {
    const bad = (error: string, d?: string) => ({ status: 400, json: { error, ...(d ? { error_description: d } : {}) } });
    if (f.get("grant_type") === "authorization_code") {
      const h = await sha256(f.get("code") ?? "");
      const c = this.db.prepare("select * from oauth_codes where hash = ?").get(h) as { client: string; redirect: string; challenge: string; expires: number } | undefined;
      this.db.prepare("delete from oauth_codes where hash = ? or expires < ?").run(h, Date.now()); // one use only
      if (!c || c.expires < Date.now()) return bad("invalid_grant", "code expired or used");
      if (c.client !== f.get("client_id") || c.redirect !== f.get("redirect_uri")) return bad("invalid_grant", "client or redirect differ");
      if (!same(await sha256(f.get("code_verifier") ?? ""), c.challenge)) return bad("invalid_grant", "PKCE verifier does not match");
      return { status: 200, json: await this.pair(c.client) };
    }
    if (f.get("grant_type") === "refresh_token") {
      const h = await sha256(f.get("refresh_token") ?? "");
      const r = this.db.prepare("select client, family, expires, revoked from tokens where hash = ? and kind = 'refresh'").get(h) as
        { client: string; family: string; expires: number; revoked: number } | undefined;
      if (!r || r.expires < Date.now()) return bad("invalid_grant");
      if (r.revoked) { // a refresh token used twice: someone else has a copy, so the whole family goes
        this.db.prepare("update tokens set revoked = 1 where family = ?").run(r.family);
        return bad("invalid_grant", "token reused");
      }
      if (f.get("client_id") && f.get("client_id") !== r.client) return bad("invalid_grant");
      this.db.prepare("update tokens set revoked = 1 where hash = ?").run(h);
      return { status: 200, json: await this.pair(r.client, r.family) };
    }
    return bad("unsupported_grant_type");
  }

  // ------------------------------------------------------------ the account page: sessions and personal tokens
  async newSession(): Promise<string> {
    const s = randomToken();
    this.db.prepare("delete from sessions where expires < ?").run(Date.now());
    this.db.prepare("insert into sessions (hash, expires) values (?, ?)").run(await sha256(s), Date.now() + 15 * 60_000);
    return s;
  }
  async session(req: Request): Promise<boolean> {
    const s = req.headers.get("cookie")?.match(/(?:^|;\s*)brain_session=([\w-]+)/)?.[1];
    if (!s) return false;
    const r = this.db.prepare("select expires from sessions where hash = ?").get(await sha256(s)) as { expires: number } | undefined;
    return !!r && r.expires > Date.now();
  }
  async createPersonal(name: string): Promise<string> {
    const t = `brain_${randomToken()}`;
    this.db.prepare("insert into tokens (hash, kind, name, created) values (?, 'personal', ?, ?)").run(await sha256(t), name.slice(0, 60), new Date().toISOString());
    return t;
  }
  personalTokens(): { name: string; created: string; used: string | null; hash: string }[] {
    return this.db.prepare("select name, created, used, hash from tokens where kind = 'personal' and revoked = 0 order by created").all() as never;
  }
  connections(): { name: string; created: string; used: string | null }[] {
    return this.db.prepare(
      `select c.name, min(t.created) created, max(t.used) used from tokens t join oauth_clients c on c.id = t.client
       where t.kind = 'access' and t.revoked = 0 group by t.family order by used desc limit 20`,
    ).all() as never;
  }
  revoke(hash: string) { this.db.prepare("update tokens set revoked = 1 where hash = ?").run(hash); }
  revokeAllClaude() { this.db.prepare("update tokens set revoked = 1 where kind in ('access', 'refresh')").run(); }
}
