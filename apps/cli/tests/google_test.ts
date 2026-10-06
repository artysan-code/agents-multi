// Tests for shared/mcp/lib/google.ts: the pieces of the OAuth flow and the mail format that do not
// need Google to answer.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  attachmentBytes,
  authUrl,
  emailFromIdToken,
  encodeHeader,
  freeName,
  htmlToText,
  labelChange,
  parseClientJson,
  pkce,
  rawMessage,
  readPayload,
  respondAttendees,
  safeFileName,
  SCOPES,
  sheetsText,
} from "../../../shared/mcp/lib/google.ts";

const unb64url = (s: string) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) =>
      c.charCodeAt(0)),
  );
const b64url = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.test("parseClientJson: the desktop client file, and a clear refusal of anything else", () => {
  assertEquals(
    parseClientJson(
      JSON.stringify({ installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "s" } }),
    ),
    { id: "123-abc.apps.googleusercontent.com", secret: "s" },
  );
  assertThrows(() => parseClientJson("{}"), Error, "not a Google OAuth client file");
});

Deno.test("authUrl: offline access, consent, PKCE S256, every scope, the login hint", async () => {
  const { verifier, challenge } = await pkce();
  assert(verifier.length >= 43 && !/[+/=]/.test(challenge));
  const u = new URL(
    authUrl({ id: "cid", secret: "x" }, "http://127.0.0.1:4242/callback", challenge, "st", "me@example.com"),
  );
  assertEquals(u.searchParams.get("access_type"), "offline");
  assertEquals(u.searchParams.get("prompt"), "consent");
  assertEquals(u.searchParams.get("code_challenge_method"), "S256");
  assertEquals(u.searchParams.get("scope")!.split(" "), SCOPES);
  assertEquals(u.searchParams.get("login_hint"), "me@example.com");
  assert(!u.toString().includes("x&") && !u.searchParams.has("client_secret"));
});

Deno.test("emailFromIdToken: the payload's address; garbage is null", () => {
  assertEquals(emailFromIdToken(`h.${b64url(JSON.stringify({ email: "a@b.c" }))}.s`), "a@b.c");
  assertEquals(emailFromIdToken("nonsense"), null);
});

Deno.test("rawMessage: headers, UTF-8 subject in RFC 2047, reply threading, base64 body", () => {
  const raw = unb64url(
    rawMessage({
      to: "a@b.c",
      subject: "Fattura di settembre — ok",
      body: "Ciao,\nè tutto a posto.",
      inReplyTo: "<id@mail>",
    }),
  );
  assert(raw.includes("To: a@b.c\r\n"));
  assert(raw.includes("Subject: =?UTF-8?B?"));
  assert(raw.includes("In-Reply-To: <id@mail>\r\nReferences: <id@mail>"));
  const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assertEquals(
    new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))),
    "Ciao,\nè tutto a posto.",
  );
  assertEquals(encodeHeader("plain"), "plain");
});

Deno.test("readPayload: plain text preferred, HTML as text otherwise, attachments listed", () => {
  const p = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: b64url("<p>Ciao <b>Samuel</b></p><p>riga</p>") } },
        ],
      },
      { mimeType: "application/pdf", filename: "fattura.pdf", body: { size: 1234, attachmentId: "att-1" } },
    ],
  };
  const r = readPayload(p);
  assertEquals(r.text, "Ciao Samuel\nriga");
  assertEquals(r.attachments, [{ name: "fattura.pdf", size: 1234, mime: "application/pdf", attachmentId: "att-1" }]);
  assertEquals(htmlToText("a&nbsp;&amp;&nbsp;b<br>c"), "a & b\nc");
});

Deno.test("attachments: Gmail's base64url to bytes, a safe name, never over an existing file", () => {
  assertEquals(new TextDecoder().decode(attachmentBytes(b64url("ciao è"))), "ciao è");
  assertEquals(safeFileName("../../.bashrc"), "_.._.bashrc");
  assertEquals(safeFileName(".hidden"), "hidden");
  assertEquals(safeFileName("a\u0000b/c.pdf"), "ab_c.pdf");
  assertEquals(safeFileName("  "), "attachment");
  const taken = new Set(["fattura.pdf", "fattura (1).pdf"]);
  assertEquals(freeName("fattura.pdf", (n) => taken.has(n)), "fattura (2).pdf");
  assertEquals(freeName("README", (n) => n === "README"), "README (1)");
  assertEquals(freeName("new.txt", () => false), "new.txt");
});

Deno.test("labelChange: read and archive as system labels, names in any case, an unknown label refused", () => {
  const labels = [{ id: "Label_1", name: "Clienti" }, { id: "INBOX", name: "INBOX" }];
  assertEquals(labelChange({ read: true, archive: true }, labels), {
    addLabelIds: [],
    removeLabelIds: ["UNREAD", "INBOX"],
  });
  assertEquals(labelChange({ read: false, addLabels: ["clienti"] }, labels), {
    addLabelIds: ["Label_1", "UNREAD"],
    removeLabelIds: [],
  });
  assertThrows(() => labelChange({ addLabels: ["Nope"] }, labels), Error, "there are: Clienti, INBOX");
});

Deno.test("respondAttendees: only the account's own answer changes; no invitation, no answer", () => {
  const list = [{ email: "a@x.test", responseStatus: "accepted" }, {
    email: "me@x.test",
    self: true,
    responseStatus: "needsAction",
  }];
  const r = respondAttendees(list, "declined");
  assertEquals(r.map((a) => a.responseStatus), ["accepted", "declined"]);
  assertEquals(list[1].responseStatus, "needsAction"); // the input is left alone
  assertThrows(() => respondAttendees([{ email: "a@x.test" }], "accepted"), Error, "not among the event's guests");
  assertThrows(() => respondAttendees(undefined, "accepted"), Error);
});

Deno.test("sheetsText: every sheet under its title, CSV quoting, cut at the limit", () => {
  const t = sheetsText([{ title: "Q1", values: [["a", "b,c"], ['say "hi"']] }, { title: "Vuoto" }], 1000);
  assertEquals(t, '## Q1\na,"b,c"\n"say ""hi"""\n\n## Vuoto\n');
  assert(sheetsText([{ title: "X", values: [["0123456789"]] }], 8).endsWith("[…cut]"));
});
