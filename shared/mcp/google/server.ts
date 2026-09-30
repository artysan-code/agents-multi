#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run=/usr/bin/secret-tool
// google — MCP server on Samuel's Google accounts (accounts.json, service "google"): Gmail,
// Calendar, Drive. Several accounts per profile (personal, acme…): each tool takes `account`.
//
// Mail goes out in two steps, and the second one always asks: gmail_draft writes a draft Samuel
// can read, gmail_send sends an existing draft — and mcp__google__gmail_send is in the shared `ask`
// permissions, so it needs his yes even in auto mode. Nothing here deletes anything.
// Calendar writes default to sendUpdates "none": invitations go out only when he asks for them.
// Drive is read-only: search, and a file's text (Docs, Sheets and Slides exported, text files read).
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";
import { z } from "npm:zod@^3.23";
import { accessToken, htmlToText, loadClient, rawMessage, readPayload } from "../lib/google.ts";
import { service, text } from "../lib/service.ts";

const google = service("google");
const account = google.accountArg;

// deno-lint-ignore no-explicit-any
type Doc = any;

async function api(acc: string | undefined, url: string, init?: RequestInit): Promise<Doc> {
  const { secret } = await google.use(acc);
  const token = await accessToken(await loadClient(), secret);
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) } });
  const body = await r.text();
  if (!r.ok) {
    let msg = body.slice(0, 300);
    try { msg = JSON.parse(body).error?.message ?? msg; } catch { /* not JSON */ }
    throw new Error(`Google ${r.status}: ${msg}`);
  }
  return body ? JSON.parse(body) : null;
}
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CAL = "https://www.googleapis.com/calendar/v3";
const DRIVE = "https://www.googleapis.com/drive/v3";
const header = (m: Doc, name: string) => m.payload?.headers?.find((h: Doc) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

const server = new McpServer({ name: "google", version: "0.1.0" });

// ---------------------------------------------------------------- Gmail
server.registerTool("gmail_search", {
  description: "Search mail with Gmail's own syntax (from:, to:, subject:, is:unread, newer_than:2d, has:attachment, in:inbox…). Newest first.",
  inputSchema: { account, query: z.string().describe("Gmail search, e.g. 'is:unread newer_than:1d'"), max: z.number().int().min(1).max(50).optional() },
}, async ({ account, query, max }: { account?: string; query: string; max?: number }) => {
  const list = await api(account, `${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(max ?? 15) })}`);
  const msgs = await Promise.all((list.messages ?? []).map((m: Doc) =>
    api(account, `${GMAIL}/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)
  ));
  return text(msgs.map((m) => ({
    id: m.id, threadId: m.threadId, from: header(m, "From"), to: header(m, "To"), subject: header(m, "Subject"), date: header(m, "Date"),
    unread: (m.labelIds ?? []).includes("UNREAD"), snippet: htmlToText(m.snippet ?? ""),  // Gmail escapes snippets as HTML
  })));
});

server.registerTool("gmail_thread", {
  description: "A whole conversation: each message's sender, recipients, date and text body, and its attachments' names. Pass a threadId (or a message id).",
  inputSchema: { account, id: z.string(), maxChars: z.number().int().optional().describe("per message, default 6000") },
}, async ({ account, id, maxChars }: { account?: string; id: string; maxChars?: number }) => {
  let t: Doc;
  try { t = await api(account, `${GMAIL}/threads/${id}?format=full`); } catch {
    const m = await api(account, `${GMAIL}/messages/${id}?format=minimal`);
    t = await api(account, `${GMAIL}/threads/${m.threadId}?format=full`);
  }
  return text({
    threadId: t.id,
    messages: t.messages.map((m: Doc) => {
      const { text: body, attachments } = readPayload(m.payload);
      return {
        id: m.id, from: header(m, "From"), to: header(m, "To"), cc: header(m, "Cc"), date: header(m, "Date"), subject: header(m, "Subject"),
        messageId: header(m, "Message-ID"), body: body.slice(0, maxChars ?? 6000) + (body.length > (maxChars ?? 6000) ? "\n[…cut]" : ""), attachments,
      };
    }),
  });
});

server.registerTool("gmail_draft", {
  description:
    "Write a draft (plain text), or replace an existing one (draftId). To reply, pass the thread's threadId and the last message's messageId " +
    "(from gmail_thread) so it stays in the conversation. It does NOT send: show Samuel the draft, then gmail_send only if he says so.",
  inputSchema: {
    account, to: z.string(), subject: z.string(), body: z.string(), cc: z.string().optional(), bcc: z.string().optional(),
    threadId: z.string().optional(), inReplyTo: z.string().optional().describe("Message-ID of the message answered"),
    draftId: z.string().optional().describe("replace this draft instead of creating one"),
  },
}, async (a: { account?: string; to: string; subject: string; body: string; cc?: string; bcc?: string; threadId?: string; inReplyTo?: string; draftId?: string }) => {
  const message = { raw: rawMessage(a), ...(a.threadId ? { threadId: a.threadId } : {}) };
  const d = a.draftId
    ? await api(a.account, `${GMAIL}/drafts/${a.draftId}`, { method: "PUT", body: JSON.stringify({ id: a.draftId, message }) })
    : await api(a.account, `${GMAIL}/drafts`, { method: "POST", body: JSON.stringify({ message }) });
  return text({ draftId: d.id, to: a.to, cc: a.cc ?? null, subject: a.subject, body: a.body, note: "draft saved, not sent" });
});

server.registerTool("gmail_drafts", {
  description: "The drafts waiting in the account: id, recipient, subject.",
  inputSchema: { account },
}, async ({ account }: { account?: string }) => {
  const list = await api(account, `${GMAIL}/drafts?maxResults=20`);
  const ds = await Promise.all((list.drafts ?? []).map((d: Doc) => api(account, `${GMAIL}/drafts/${d.id}?format=metadata`)));
  return text(ds.map((d) => ({ draftId: d.id, to: header(d.message, "To"), subject: header(d.message, "Subject"), snippet: htmlToText(d.message.snippet ?? "") })));
});

server.registerTool("gmail_send", {
  description: "Send an existing draft. Only when Samuel has asked to send it (this tool always asks for his approval).",
  inputSchema: { account, draftId: z.string() },
}, async ({ account, draftId }: { account?: string; draftId: string }) => {
  const r = await api(account, `${GMAIL}/drafts/send`, { method: "POST", body: JSON.stringify({ id: draftId }) });
  return text({ sent: true, messageId: r.id, threadId: r.threadId });
});

// ---------------------------------------------------------------- Calendar
const when = z.string().describe("RFC 3339 with offset (2026-10-01T10:00:00+02:00), or a day YYYY-MM-DD for all-day");
const slot = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v };

server.registerTool("calendar_list", {
  description: "The calendars of an account: id, name, whether it is the primary one and what can be done on it.",
  inputSchema: { account },
}, async ({ account }: { account?: string }) => {
  const r = await api(account, `${CAL}/users/me/calendarList`);
  return text((r.items ?? []).map((c: Doc) => ({ id: c.id, name: c.summaryOverride ?? c.summary, primary: !!c.primary, access: c.accessRole })));
});

server.registerTool("calendar_events", {
  description: "Events between two moments (default: the rest of today), expanded (recurring ones as their occurrences), in start order.",
  inputSchema: {
    account, from: z.string().optional().describe("RFC 3339; default now"), to: z.string().optional().describe("RFC 3339; default end of today"),
    calendarId: z.string().optional().describe("default primary"), query: z.string().optional(),
  },
}, async ({ account, from, to, calendarId, query }: { account?: string; from?: string; to?: string; calendarId?: string; query?: string }) => {
  const now = new Date(), end = new Date(now); end.setHours(23, 59, 59, 0);
  const q = new URLSearchParams({ timeMin: from ?? now.toISOString(), timeMax: to ?? end.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "100", ...(query ? { q: query } : {}) });
  const r = await api(account, `${CAL}/calendars/${encodeURIComponent(calendarId ?? "primary")}/events?${q}`);
  return text((r.items ?? []).map((e: Doc) => ({
    id: e.id, title: e.summary ?? "(no title)", start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date,
    location: e.location ?? null, meet: e.hangoutLink ?? null, attendees: (e.attendees ?? []).length, status: e.status,
    myResponse: e.attendees?.find((a: Doc) => a.self)?.responseStatus ?? null,
  })));
});

const eventFields = {
  title: z.string().optional(), start: when.optional(), end: when.optional(), description: z.string().optional(), location: z.string().optional(),
  attendees: z.array(z.string()).optional().describe("email addresses"),
  sendUpdates: z.enum(["none", "all", "externalOnly"]).optional().describe("invitations by mail: default none; 'all' only when Samuel asks"),
};
const eventBody = (a: { title?: string; start?: string; end?: string; description?: string; location?: string; attendees?: string[] }) => ({
  ...(a.title !== undefined ? { summary: a.title } : {}), ...(a.start ? { start: slot(a.start) } : {}), ...(a.end ? { end: slot(a.end) } : {}),
  ...(a.description !== undefined ? { description: a.description } : {}), ...(a.location !== undefined ? { location: a.location } : {}),
  ...(a.attendees ? { attendees: a.attendees.map((email) => ({ email })) } : {}),
});

server.registerTool("calendar_create", {
  description: "Create an event. With attendees, invitations go out only if sendUpdates says so.",
  inputSchema: { account, calendarId: z.string().optional(), ...eventFields, title: z.string(), start: when, end: when },
}, async (a: Doc) => {
  const e = await api(a.account, `${CAL}/calendars/${encodeURIComponent(a.calendarId ?? "primary")}/events?sendUpdates=${a.sendUpdates ?? "none"}`, { method: "POST", body: JSON.stringify(eventBody(a)) });
  return text({ id: e.id, title: e.summary, start: e.start, end: e.end, link: e.htmlLink });
});

server.registerTool("calendar_update", {
  description: "Change an event: only the fields given change. Same rule for invitations as calendar_create.",
  inputSchema: { account, calendarId: z.string().optional(), eventId: z.string(), ...eventFields },
}, async (a: Doc) => {
  const e = await api(a.account, `${CAL}/calendars/${encodeURIComponent(a.calendarId ?? "primary")}/events/${encodeURIComponent(a.eventId)}?sendUpdates=${a.sendUpdates ?? "none"}`, { method: "PATCH", body: JSON.stringify(eventBody(a)) });
  return text({ id: e.id, title: e.summary, start: e.start, end: e.end, link: e.htmlLink });
});

// ---------------------------------------------------------------- Drive
server.registerTool("drive_search", {
  description: "Find files: by words in the name or content, optionally only the ones shared with the account. Newest first.",
  inputSchema: {
    account, text: z.string().optional().describe("words to find in name or content"), sharedWithMe: z.boolean().optional(),
    max: z.number().int().min(1).max(50).optional(),
  },
}, async ({ account, text: words, sharedWithMe, max }: { account?: string; text?: string; sharedWithMe?: boolean; max?: number }) => {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const q = ["trashed = false", words ? `(name contains '${esc(words)}' or fullText contains '${esc(words)}')` : null, sharedWithMe ? "sharedWithMe = true" : null].filter(Boolean).join(" and ");
  const r = await api(account, `${DRIVE}/files?${new URLSearchParams({
    q, pageSize: String(max ?? 20), orderBy: "modifiedTime desc", includeItemsFromAllDrives: "true", supportsAllDrives: "true",
    fields: "files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress),webViewLink,size)",
  })}`);
  return text((r.files ?? []).map((f: Doc) => ({ id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, owner: f.owners?.[0]?.emailAddress ?? null, link: f.webViewLink })));
});

const EXPORT: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

server.registerTool("drive_read", {
  description: "A file's text: Google Docs and Slides as text, Sheets as CSV (first sheet), text files as they are. Other formats (PDF, images): details and link only.",
  inputSchema: { account, id: z.string(), maxChars: z.number().int().optional().describe("default 20000") },
}, async ({ account, id, maxChars }: { account?: string; id: string; maxChars?: number }) => {
  const f = await api(account, `${DRIVE}/files/${id}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`);
  const { secret } = await google.use(account);
  const token = await accessToken(await loadClient(), secret);
  const url = EXPORT[f.mimeType]
    ? `${DRIVE}/files/${id}/export?mimeType=${encodeURIComponent(EXPORT[f.mimeType])}`
    : f.mimeType.startsWith("text/") || f.mimeType === "application/json" ? `${DRIVE}/files/${id}?alt=media&supportsAllDrives=true` : null;
  if (!url) return text({ name: f.name, type: f.mimeType, size: f.size ?? null, link: f.webViewLink, note: "not a text format: open the link" });
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Google ${r.status} reading ${f.name}`);
  const body = await r.text(), limit = maxChars ?? 20000;
  return text({ name: f.name, type: f.mimeType, link: f.webViewLink, text: body.slice(0, limit) + (body.length > limit ? "\n[…cut]" : "") });
});

await server.connect(new StdioServerTransport());
