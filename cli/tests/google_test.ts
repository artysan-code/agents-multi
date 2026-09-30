// Tests for shared/mcp/lib/google.ts: the pieces of the OAuth flow and the mail format that do not
// need Google to answer.
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { authUrl, emailFromIdToken, encodeHeader, htmlToText, parseClientJson, pkce, rawMessage, readPayload, SCOPES } from "../../shared/mcp/lib/google.ts";

const unb64url = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4)), (c) => c.charCodeAt(0)));
const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

Deno.test("parseClientJson: the desktop client file, and a clear refusal of anything else", () => {
  assertEquals(parseClientJson(JSON.stringify({ installed: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "s" } })), { id: "123-abc.apps.googleusercontent.com", secret: "s" });
  assertThrows(() => parseClientJson("{}"), Error, "not a Google OAuth client file");
});

Deno.test("authUrl: offline access, consent, PKCE S256, every scope, the login hint", async () => {
  const { verifier, challenge } = await pkce();
  assert(verifier.length >= 43 && !/[+/=]/.test(challenge));
  const u = new URL(authUrl({ id: "cid", secret: "x" }, "http://127.0.0.1:4242/callback", challenge, "st", "me@example.com"));
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
  const raw = unb64url(rawMessage({ to: "a@b.c", subject: "Fattura di settembre — ok", body: "Ciao,\nè tutto a posto.", inReplyTo: "<id@mail>" }));
  assert(raw.includes("To: a@b.c\r\n"));
  assert(raw.includes("Subject: =?UTF-8?B?"));
  assert(raw.includes("In-Reply-To: <id@mail>\r\nReferences: <id@mail>"));
  const body = raw.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assertEquals(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))), "Ciao,\nè tutto a posto.");
  assertEquals(encodeHeader("plain"), "plain");
});

Deno.test("readPayload: plain text preferred, HTML as text otherwise, attachments listed", () => {
  const p = {
    mimeType: "multipart/mixed", parts: [
      { mimeType: "multipart/alternative", parts: [
        { mimeType: "text/html", body: { data: b64url("<p>Ciao <b>Samuel</b></p><p>riga</p>") } },
      ] },
      { mimeType: "application/pdf", filename: "fattura.pdf", body: { size: 1234 } },
    ],
  };
  const r = readPayload(p);
  assertEquals(r.text, "Ciao Samuel\nriga");
  assertEquals(r.attachments, [{ name: "fattura.pdf", size: 1234, mime: "application/pdf" }]);
  assertEquals(htmlToText("a&nbsp;&amp;&nbsp;b<br>c"), "a & b\nc");
});
