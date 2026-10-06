// Tests for the public pages (public.ts): what they say comes from the instance, escaped, and the
// notice names every Google scope claude-multi asks for.
import { assert, assertStringIncludes } from "jsr:@std/assert@1";
import { landingPage, privacyPage } from "../public.ts";
import { SCOPES } from "../../shared/mcp/lib/google.ts";

const site = { url: "https://b.test", operator: "Ann <x>", contact: "privacy@b.test", hosting: "un server a Parigi" };

Deno.test("public: the landing names the operator, escaped, and links sign-in and privacy", () => {
  const h = landingPage(site);
  assertStringIncludes(h, "Ann &lt;x&gt;");
  for (const href of ['href="/tasks"', 'href="/account"', 'href="/privacy"']) assertStringIncludes(h, href);
});

Deno.test("public: the notice carries contact, hosting, Limited Use, and every Google scope", () => {
  const h = privacyPage(site);
  assertStringIncludes(h, 'mailto:privacy@b.test');
  assertStringIncludes(h, "un server a Parigi");
  assertStringIncludes(h, "Limited Use");
  assertStringIncludes(h, "indirizzo email"); // openid + email
  for (const s of SCOPES.filter((s) => s.startsWith("https://"))) assertStringIncludes(h, `<code>${s.replace("https://www.googleapis.com/auth/", "")}</code>`);
});

Deno.test("public: without a contact the notice points to the administrator, never an empty mailto", () => {
  const h = privacyPage({ ...site, contact: "" });
  assert(!h.includes("mailto:"));
  assertStringIncludes(h, "l'amministratore del servizio");
});
