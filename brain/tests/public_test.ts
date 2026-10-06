// Tests for what is public (public.ts): the site's paths stay inside it and off the brain's, its
// placeholders take the instance's particulars, its files are served with the right headers, the
// brain's address sends visitors to the site's own, and the notice names every Google scope.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { contactOf, fillSite, privacyPage, siteCache, siteFile, siteMoved, sitePath } from "../public.ts";
import { SCOPES } from "../../shared/mcp/lib/google.ts";

const site = { url: "https://b.test", siteUrl: "https://s.test", operator: "Ann <x>", contact: "privacy@b.test", hosting: "un server a Parigi" };

Deno.test("public: a path maps to a file of the site, never outside it nor onto the brain's", () => {
  assertEquals(sitePath("/"), "index.html");
  assertEquals(sitePath("/it/"), "it/index.html");
  assertEquals(sitePath("/docs/brain"), "docs/brain/index.html");
  assertEquals(sitePath("/_astro/a.B1x.css"), "_astro/a.B1x.css");
  assertEquals(sitePath("/%2e%2e/accounts.db"), null);
  assertEquals(sitePath("/docs/../../data"), null);
  assertEquals(sitePath("/%E0%A4%A"), null);
  for (const p of ["/mcp", "/mcp/x", "/api/tasks", "/backup", "/tasks", "/account/login", "/privacy", "/.well-known/x"]) assertEquals(sitePath(p), null, p);
  assertEquals(sitePath("/mcpx/"), "mcpx/index.html");
});

Deno.test("public: the site's placeholders take the instance's particulars, escaped, out of Cloudflare's obfuscation", () => {
  const page = '<html><head><link rel="canonical" href="https://site.invalid/it/"></head><body class="x"><a href="mailto:__CONTACT__">Write</a> by __OPERATOR__ <a href="__APP__/tasks">in</a></body></html>';
  const h = fillSite(page, site);
  assertStringIncludes(h, 'href="https://s.test/it/"');
  assertStringIncludes(h, 'href="mailto:privacy@b.test"');
  assertStringIncludes(h, "by Ann &lt;x&gt;");
  assertStringIncludes(h, 'href="https://b.test/tasks"');
  assertStringIncludes(h, '<body class="x"><!--email_off-->');
  assertStringIncludes(h, "<!--/email_off--></body>");
  assertStringIncludes(fillSite(page, { ...site, contact: "" }), 'href="https://b.test/privacy"');
  assertStringIncludes(fillSite(page, { ...site, operator: "$& $'" }), "by $&amp; $&#39;"); // no replacement patterns
  assertEquals(fillSite("Sitemap: https://site.invalid/sitemap-index.xml", site, false), "Sitemap: https://s.test/sitemap-index.xml");
});

Deno.test("public: only a plain address reaches a mailto link", () => {
  assertEquals(contactOf(site), "privacy@b.test");
  assertEquals(contactOf({ ...site, contact: "a@b.test?cc=x@y.test" }), "");
  assertEquals(contactOf({ ...site, contact: "" }), "");
});

Deno.test("public: hashed assets are kept for a year, pages revalidated, the rest for a month", () => {
  assertEquals(siteCache("_astro/x.A1.js"), "public, max-age=31536000, immutable");
  assertEquals(siteCache("it/index.html"), "no-cache");
  assertEquals(siteCache("sitemap-0.xml"), "no-cache");
  assertEquals(siteCache("fonts/dm-sans.woff2"), "public, max-age=2592000");
});

Deno.test("public: a file of the site is served with its type, its CSP and filled; a missing one is not", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/it`);
    await Deno.writeTextFile(`${dir}/it/index.html`, "<body>__OPERATOR__</body>");
    await Deno.writeTextFile(`${dir}/mark.svg`, "<svg/>");
    const h = (await siteFile(dir, "/it/", site))!;
    assertEquals(h.headers.get("content-type"), "text/html; charset=utf-8");
    assertStringIncludes(h.headers.get("content-security-policy")!, "frame-ancestors 'none'");
    assertStringIncludes(await h.text(), "Ann &lt;x&gt;");
    const svg = (await siteFile(dir, "/mark.svg", site))!;
    assertStringIncludes(svg.headers.get("content-security-policy")!, "sandbox");
    assertEquals((await siteFile(dir, "/it/", site, 404))!.status, 404);
    assertEquals(await siteFile(dir, "/nope/", site), null);
    assertEquals(await siteFile(dir, "/mcp", site), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("public: the brain's address sends a page of the site to the site's own, and keeps its own paths", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/docs`);
    await Deno.writeTextFile(`${dir}/index.html`, "");
    await Deno.writeTextFile(`${dir}/docs/index.html`, "");
    assertEquals(await siteMoved(dir, new URL("https://b.test/"), site), "https://s.test/");
    assertEquals(await siteMoved(dir, new URL("https://b.test/docs/?q=1"), site), "https://s.test/docs/?q=1");
    assertEquals(await siteMoved(dir, new URL("https://b.test/tasks"), site), null);
    assertEquals(await siteMoved(dir, new URL("https://b.test/nope"), site), null);
    assertEquals(await siteMoved(dir, new URL("https://b.test/"), { ...site, siteUrl: site.url }), null); // one address: nothing moves
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("public: the notice carries contact, hosting, Limited Use, and every Google scope", () => {
  const h = privacyPage(site);
  assertStringIncludes(h, "mailto:privacy@b.test");
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
