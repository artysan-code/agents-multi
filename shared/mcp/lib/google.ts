// google.ts — what the google MCP server and the console share: the OAuth client, the scopes, the
// authorisation flow (loopback + PKCE, as Google wants for desktop apps), access tokens, and the
// mail format.
//
// Secrets, all in the vault (vault.ts):
//   google-oauth/client  fields id, secret — the OAuth client of Samuel's Google Cloud project, one
//                        for every account (a "Desktop app" client: its secret is not a real secret
//                        by Google's own definition, but it stays in the vault like the rest)
//   google/<account>     field token — that account's refresh token
// Access tokens live in memory only, for the hour Google gives them.
//
// The project must be published ("In production"): in "Testing" Google expires refresh tokens after
// seven days, and every account would have to be connected again each week.

import { getSecret } from "./vault.ts";

export const SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.readonly", // read and search mail
  "https://www.googleapis.com/auth/gmail.compose", // drafts, and sending them
  "https://www.googleapis.com/auth/calendar.events", // read and write events
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly", // which calendars there are
  "https://www.googleapis.com/auth/drive.readonly", // files, the shared ones included
];
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";

export interface Client { id: string; secret: string }

export async function loadClient(): Promise<Client> {
  const [id, secret] = await Promise.all([getSecret("google-oauth", "client", "id"), getSecret("google-oauth", "client", "secret")]);
  if (!id || !secret) throw new Error("no Google OAuth client on this machine: import it in the console (Connections) or with `claude-multi google client <file.json>`");
  return { id, secret };
}

/** Pure: the client out of the JSON Google Cloud lets you download ("installed" for desktop apps). */
export function parseClientJson(text: string): Client {
  const j = JSON.parse(text);
  const c = j.installed ?? j.web;
  if (!c?.client_id || !c?.client_secret) throw new Error("not a Google OAuth client file: it has no installed.client_id / client_secret");
  return { id: c.client_id, secret: c.client_secret };
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Pure: the consent page's address. offline + consent: Google returns a refresh token only then. */
export function authUrl(client: Client, redirect: string, challenge: string, state: string, loginHint?: string): string {
  const q = new URLSearchParams({
    client_id: client.id, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${AUTH}?${q}`;
}

async function tokenCall(body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google token endpoint: ${j.error ?? r.status}${j.error_description ? ` — ${j.error_description}` : ""}`);
  return j;
}

/** The code from the consent page, for a refresh token and the account's address. */
export async function exchangeCode(client: Client, code: string, verifier: string, redirect: string): Promise<{ refresh: string; email: string | null }> {
  const j = await tokenCall({ client_id: client.id, client_secret: client.secret, code, code_verifier: verifier, redirect_uri: redirect, grant_type: "authorization_code" });
  if (typeof j.refresh_token !== "string") throw new Error("Google returned no refresh token: revoke the app's access in the Google account and connect again");
  return { refresh: j.refresh_token, email: typeof j.id_token === "string" ? emailFromIdToken(j.id_token) : null };
}

/** Pure: the address in an ID token's payload (read, not verified: it only labels the account). */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const p = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(p + "=".repeat((4 - p.length % 4) % 4)), (c) => c.charCodeAt(0)))).email ?? null;
  } catch {
    return null;
  }
}

/** Access tokens per refresh token, kept until a minute before they expire. */
const cache = new Map<string, { token: string; until: number }>();
export async function accessToken(client: Client, refresh: string): Promise<string> {
  const hit = cache.get(refresh);
  if (hit && hit.until > Date.now()) return hit.token;
  const j = await tokenCall({ client_id: client.id, client_secret: client.secret, refresh_token: refresh, grant_type: "refresh_token" });
  const token = String(j.access_token);
  cache.set(refresh, { token, until: Date.now() + (Number(j.expires_in ?? 3600) - 60) * 1000 });
  return token;
}

// ---------------------------------------------------------------- mail format
/** Pure: a header value in RFC 2047 when it is not plain ASCII. */
export function encodeHeader(v: string): string {
  // deno-lint-ignore no-control-regex
  if (/^[\x00-\x7f]*$/.test(v)) return v;
  return `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(v)))}?=`;
}

export interface Draft { to: string; subject: string; body: string; cc?: string; bcc?: string; inReplyTo?: string; references?: string }

/** Pure: a plain-text UTF-8 message as Gmail's `raw` (base64url of the RFC 5322 text). */
export function rawMessage(d: Draft): string {
  const bodyB64 = btoa(String.fromCharCode(...new TextEncoder().encode(d.body))).replace(/.{76}/g, "$&\r\n");
  const headers = [
    `To: ${d.to}`,
    d.cc ? `Cc: ${d.cc}` : null,
    d.bcc ? `Bcc: ${d.bcc}` : null,
    `Subject: ${encodeHeader(d.subject)}`,
    d.inReplyTo ? `In-Reply-To: ${d.inReplyTo}` : null,
    d.references || d.inReplyTo ? `References: ${d.references ?? d.inReplyTo}` : null,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean);
  return b64url(new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n${bodyB64}`));
}

const fromB64url = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0)));

/** Pure: HTML to readable text — enough for mail bodies, not a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// deno-lint-ignore no-explicit-any
type Part = any;
/** Pure: a Gmail message payload to its text body and its attachments' names. */
export function readPayload(payload: Part): { text: string; attachments: { name: string; size: number; mime: string }[] } {
  let plain = "", html = "";
  const attachments: { name: string; size: number; mime: string }[] = [];
  const walk = (p: Part) => {
    if (!p) return;
    if (p.filename) attachments.push({ name: p.filename, size: p.body?.size ?? 0, mime: p.mimeType });
    else if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = fromB64url(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = fromB64url(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return { text: plain || htmlToText(html), attachments };
}
