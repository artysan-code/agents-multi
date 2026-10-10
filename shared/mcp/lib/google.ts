// google.ts — what the google MCP server and the console share: the OAuth client, the scopes, the
// authorisation flow (loopback + PKCE, as Google wants for desktop apps), access tokens, and the
// mail format.
//
// Secrets, all in the vault (vault.ts):
//   google-oauth/client  fields id, secret — the OAuth client of the owner's Google Cloud project, one
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
  "https://www.googleapis.com/auth/gmail.modify", // read, drafts and sending them, labels and archiving (never permanent deletion)
  "https://www.googleapis.com/auth/calendar.events", // read and write events
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly", // which calendars there are
  "https://www.googleapis.com/auth/drive.readonly", // files, the shared ones included
];
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";

interface Client {
  id: string;
  secret: string;
}

export async function loadClient(): Promise<Client> {
  const [id, secret] = await Promise.all([
    getSecret("google-oauth", "client", "id"),
    getSecret("google-oauth", "client", "secret"),
  ]);
  if (!id || !secret) {
    throw new Error(
      "no Google OAuth client on this machine: import it in the console (Connections) or with `agents google client <file.json>`",
    );
  }
  return { id, secret };
}

/** Pure: the client out of the JSON Google Cloud lets you download ("installed" for desktop apps). */
export function parseClientJson(text: string): Client {
  const j = JSON.parse(text);
  const c = j.installed ?? j.web;
  if (!c?.client_id || !c?.client_secret) {
    throw new Error("not a Google OAuth client file: it has no installed.client_id / client_secret");
  }
  return { id: c.client_id, secret: c.client_secret };
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  return { verifier, challenge };
}

/** Pure: the consent page's address. offline + consent: Google returns a refresh token only then. */
export function authUrl(
  client: Client,
  redirect: string,
  challenge: string,
  state: string,
  loginHint?: string,
): string {
  const q = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `${AUTH}?${q}`;
}

async function tokenCall(body: Record<string, string>): Promise<Record<string, unknown>> {
  const r = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      `Google token endpoint: ${j.error ?? r.status}${j.error_description ? ` — ${j.error_description}` : ""}`,
    );
  }
  return j;
}

/** The code from the consent page, for a refresh token and the account's address. */
export async function exchangeCode(
  client: Client,
  code: string,
  verifier: string,
  redirect: string,
): Promise<{ refresh: string; email: string | null }> {
  const j = await tokenCall({
    client_id: client.id,
    client_secret: client.secret,
    code,
    code_verifier: verifier,
    redirect_uri: redirect,
    grant_type: "authorization_code",
  });
  if (typeof j.refresh_token !== "string") {
    throw new Error(
      "Google returned no refresh token: revoke the app's access in the Google account and connect again",
    );
  }
  return { refresh: j.refresh_token, email: typeof j.id_token === "string" ? emailFromIdToken(j.id_token) : null };
}

/** Pure: the address in an ID token's payload (read, not verified: it only labels the account). */
export function emailFromIdToken(idToken: string): string | null {
  try {
    const p = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(p + "=".repeat((4 - p.length % 4) % 4)), (c) => c.charCodeAt(0))),
    ).email ?? null;
  } catch {
    return null;
  }
}

/** Access tokens per refresh token, kept until a minute before they expire. */
const cache = new Map<string, { token: string; until: number }>();
export async function accessToken(client: Client, refresh: string): Promise<string> {
  const hit = cache.get(refresh);
  if (hit && hit.until > Date.now()) return hit.token;
  const j = await tokenCall({
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refresh,
    grant_type: "refresh_token",
  });
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

interface Draft {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  inReplyTo?: string;
  references?: string;
}

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
  new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) =>
      c.charCodeAt(0)),
  );

/** Pure: HTML to readable text — enough for mail bodies, not a renderer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// deno-lint-ignore no-explicit-any
type Part = any;
export interface Attachment {
  name: string;
  size: number;
  mime: string;
  attachmentId: string | null;
}
/** Pure: a Gmail message payload to its text body and its attachments (with the id that fetches each). */
export function readPayload(payload: Part): { text: string; attachments: Attachment[] } {
  let plain = "", html = "";
  const attachments: Attachment[] = [];
  const walk = (p: Part) => {
    if (!p) return;
    if (p.filename) {
      attachments.push({
        name: p.filename,
        size: p.body?.size ?? 0,
        mime: p.mimeType,
        attachmentId: p.body?.attachmentId ?? null,
      });
    } else if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = fromB64url(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = fromB64url(p.body.data);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  return { text: plain || htmlToText(html), attachments };
}

/** Pure: Gmail's base64url attachment data as bytes. */
export function attachmentBytes(data: string): Uint8Array {
  return Uint8Array.from(
    atob(data.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - data.length % 4) % 4)),
    (c) => c.charCodeAt(0),
  );
}

/** Pure: a file name a sender chose, made safe to write: no folders, no control characters, not hidden. */
export function safeFileName(name: string): string {
  // deno-lint-ignore no-control-regex
  const n = name.replace(/[\x00-\x1f\x7f]/g, "").replace(/[\/\\]/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 200);
  return n || "attachment";
}

/** Pure: the first of name, "name (1).ext", "name (2).ext"… that `taken` says is free. */
export function freeName(name: string, taken: (n: string) => boolean): string {
  if (!taken(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1;; i++) if (!taken(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
}

// ---------------------------------------------------------------- labels and invitations
interface Label {
  id: string;
  name: string;
}

/** Pure: what to add and remove on messages, from plain wishes and label names (any case). A name
 *  that is not a label of the account is refused with the ones there are, never created. */
export function labelChange(
  want: { read?: boolean; archive?: boolean; addLabels?: string[]; removeLabels?: string[] },
  labels: Label[],
): { addLabelIds: string[]; removeLabelIds: string[] } {
  const byName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]));
  const ids = (names: string[] = []) =>
    names.map((n) => {
      const id = byName.get(n.toLowerCase());
      if (!id) throw new Error(`no label "${n}" in this account; there are: ${labels.map((l) => l.name).join(", ")}`);
      return id;
    });
  const add = ids(want.addLabels), remove = ids(want.removeLabels);
  if (want.read === true) remove.push("UNREAD");
  if (want.read === false) add.push("UNREAD");
  if (want.archive === true) remove.push("INBOX");
  if (want.archive === false) add.push("INBOX");
  return { addLabelIds: [...new Set(add)], removeLabelIds: [...new Set(remove)] };
}

/** Pure: an event's attendees with the account's own answer changed; refused when it is not invited. */
export function respondAttendees(
  attendees: Part[] | undefined,
  response: "accepted" | "declined" | "tentative",
): Part[] {
  const list = (attendees ?? []).map((a: Part) => ({ ...a }));
  const self = list.find((a: Part) => a.self);
  if (!self) throw new Error("this account is not among the event's guests: there is no invitation to answer");
  self.responseStatus = response;
  return list;
}

/** Pure: a spreadsheet's sheets as text, each under its title, cut at `limit` characters in all. */
export function sheetsText(sheets: { title: string; values?: string[][] }[], limit: number): string {
  const cell = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const all = sheets.map((s) =>
    `## ${s.title}\n${(s.values ?? []).map((row) => row.map((v) => cell(String(v ?? ""))).join(",")).join("\n")}`
  ).join("\n\n");
  return all.length > limit ? `${all.slice(0, limit)}\n[…cut]` : all;
}
