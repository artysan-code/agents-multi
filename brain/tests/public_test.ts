// Tests for what is public (public.ts): the site's paths stay inside it, its placeholders take the
// instance's particulars, and the notice names every Google scope claude-multi asks for.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fillSite, privacyPage, sitePath } from "../public.ts";
import { SCOPES } from "../../shared/mcp/lib/google.ts";

const site = { url: "https://b.test", operator: "Ann <x>", contact: "privacy@b.test", hosting: "un server a Parigi" };

Deno.test("public: a path maps to a file of the site, never outside it", () => {
  assertEquals(sitePath("/"), "index.html");
  assertEquals(sitePath("/it/"), "it/index.html");
  assertEquals(sitePath("/docs/brain"), "docs/brain/index.html");
  assertEquals(sitePath("/_astro/a.B1x.css"), "_astro/a.B1x.css");
  assertEquals(sitePath("/%2e%2e/accounts.db"), null);
  assertEquals(sitePath("/docs/../../data"), null);
  assertEquals(sitePath("/%E0%A4%A"), null);
});

Deno.test("public: the site's placeholders take the instance's particulars, escaped, out of Cloudflare's obfuscation", () => {
  const page = '<html><body class="x"><a href="mailto:__CONTACT__">Write</a> by __OPERATOR__</body></html>';
  const h = fillSite(page, site);
  assertStringIncludes(h, 'href="mailto:privacy@b.test"');
  assertStringIncludes(h, "by Ann &lt;x&gt;");
  assertStringIncludes(h, '<body class="x"><!--email_off-->');
  assertStringIncludes(h, "<!--/email_off--></body>");
  assertStringIncludes(fillSite(page, { ...site, contact: "" }), 'href="/privacy"');
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
