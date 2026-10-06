// public.ts — what anyone can open without an account: claude-multi's site (the landing and the docs,
// built from site/ into site/dist by the image) and `/privacy`, the privacy notice. The site has an
// address of its own when BRAIN_SITE_URL names one: a different origin from the brain's, so nothing
// the site runs can act with a brain session; the brain's address then sends its visitors there. The notice covers
// this service and claude-multi's Google integration, since its OAuth client points here (Google wants
// a public notice for it). Who runs the instance, how to reach them and where it is hosted come from
// the environment (BRAIN_OPERATOR, BRAIN_CONTACT, BRAIN_HOSTING): nothing about one person is written
// here or in the site, which carries placeholders the brain fills when it serves a page.

import { esc, page } from "./pages.ts";

export interface Site {
  /** the brain's address */
  url: string;
  /** the site's address: the brain's own unless the site has one of its own */
  siteUrl: string;
  /** who runs this instance: the data controller */
  operator: string;
  /** an address that reaches them; empty when not set */
  contact: string;
  /** where the server is, in a sentence fragment ("un server a Francoforte, in Germania") */
  hosting: string;
}

/** When the notice last changed: bump it with every change of substance. */
export const PRIVACY_UPDATED = "6 ottobre 2026";

const GOOGLE_SCOPES: [string, string][] = [
  ["gmail.modify", "leggere e cercare la posta, scrivere bozze e inviarle solo quando lo chiedi tu, segnarla come letta, archiviarla ed etichettarla; mai cancellarla"],
  ["calendar.events", "leggere gli eventi, crearli, modificarli, rispondere agli inviti; cancellarli solo quando lo chiedi tu"],
  ["calendar.calendarlist.readonly", "sapere quali calendari hai"],
  ["drive.readonly", "cercare e leggere i file di Drive, senza modificarli"],
];

/** Pure: the contact when it is a plain address, else empty (nothing else may reach a mailto: link). */
export const contactOf = (s: Site) => /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(s.contact) ? s.contact : "";

// email_off: Cloudflare's email obfuscation would swap the address for a script, which the CSP blocks
const contactLine = (s: Site) =>
  contactOf(s) ? `<!--email_off--><a href="mailto:${contactOf(s)}">${contactOf(s)}</a><!--/email_off-->` : "l'amministratore del servizio";

const footer = (s: Site) => `
  <p class="foot"><a href="${esc(s.siteUrl)}/">claude-multi</a> · <a href="${esc(s.siteUrl)}/docs/">Docs</a> · <a href="${esc(s.url)}/tasks">Entra</a></p>`;

export function privacyPage(s: Site) {
  const scopes = GOOGLE_SCOPES.map(([k, v]) => `<li><code>${k}</code>: ${v}</li>`).join("");
  return page("Privacy · Brain", `<article class="doc">
  <h1>Privacy</h1>
  <p class="sub">Aggiornata il ${PRIVACY_UPDATED}</p>

  <h2>Chi tratta i dati</h2>
  <p>Il titolare è ${esc(s.operator)}, che gestisce questo servizio (${esc(s.url)}). Per qualsiasi domanda o richiesta: ${contactLine(s)}.</p>
  <p>Questa informativa copre due cose: il servizio <b>Brain</b> su questo indirizzo, e l'integrazione con <b>Google</b> (Gmail, Calendar, Drive) di claude-multi, il software che lo collega ai Claude di chi lo usa.</p>

  <h2>Brain: cosa tiene</h2>
  <ul class="list">
    <li><b>L'account</b>: un identificativo, il nome, la lingua, la passphrase (solo come hash) e il segreto del codice di autenticazione (cifrato).</li>
    <li><b>Quello che scrivi tu o i Claude che colleghi</b>: pagine di memoria, task, e la storia delle loro versioni, con chi le ha fatte e quando.</li>
    <li><b>Gli accessi</b>: i token dei tuoi computer e delle connessioni di Claude, salvati solo come hash, e la chiave delle tue copie (cifrata).</li>
    <li><b>Dati tecnici</b>: i log del server (indirizzo IP, richiesta, orario), per farlo funzionare e tenerlo sicuro.</li>
  </ul>
  <p>Un solo cookie, <code>brain_session</code>, tecnico: ti tiene dentro per un'ora dall'ultimo uso, dodici al massimo. Niente statistiche, pubblicità o tracciamento, né qui né da terze parti.</p>

  <h2>Brain: dove sta e chi lo vede</h2>
  <p>I dati stanno su ${esc(s.hosting)}, un database per persona. La ricerca per significato è calcolata da un modello che gira sullo stesso server: i contenuti non vanno a servizi esterni per questo. Le copie di sicurezza vanno solo sui computer della persona, cifrate con la sua chiave.</p>
  <p>Li vedono: tu; i Claude che colleghi, quando li usi (in quel momento vale anche l'informativa di Anthropic); l'amministratore, che come chi gestisce un server può tecnicamente leggerne i database, e lo dice nell'invito. Nessun dato viene venduto o ceduto.</p>

  <h2>Google: cosa legge e cosa no</h2>
  <p>L'integrazione Google gira sul tuo computer, non su questo server. Chiede solo questi permessi, e li usa solo quando lo chiedi a Claude:</p>
  <ul class="list"><li><code>openid</code>, <code>email</code>: il tuo indirizzo email, per sapere quale account è collegato</li>${scopes}</ul>
  <p>Il token di accesso resta nel tuo computer, in un archivio cifrato; gli allegati che chiedi di scaricare finiscono nella tua cartella dei download. Quello che legge va solo alla tua conversazione con Claude, per rispondere a quello che hai chiesto: non viene salvato su questo server né altrove, non viene usato per pubblicità, non viene venduto, non serve ad addestrare modelli di intelligenza artificiale, e nessuno lo legge se non tu.</p>
  <p>L'uso e il trasferimento ad altre applicazioni delle informazioni ricevute dalle API di Google rispettano le <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, compresi i requisiti di Limited Use. Puoi togliere l'accesso in qualsiasi momento da <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>

  <h2>Perché, e per quanto</h2>
  <p>I dati servono a darti il servizio che hai chiesto (art. 6.1.b GDPR); i log a tenerlo sicuro (interesse legittimo, art. 6.1.f). Restano finché l'account esiste; i log per il tempo che serve a capire un problema.</p>

  <h2>I tuoi diritti</h2>
  <p>Puoi chiedere di vedere, correggere, esportare o cancellare i tuoi dati, e opporti al trattamento, scrivendo a ${contactLine(s)}. Puoi anche rivolgerti all'autorità di controllo del tuo paese (in Italia, il <a href="https://www.garanteprivacy.it">Garante per la protezione dei dati personali</a>).</p>
  ${footer(s)}</article>`, true);
}

// ---------------------------------------------------------------- the site

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json", xml: "application/xml", txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", webp: "image/webp", ico: "image/x-icon", woff2: "font/woff2", wasm: "application/wasm",
};
// Starlight's inline scripts and Pagefind's wasm need what the brain's own pages never allow
const SITE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
// the paths that are the brain's on any address: never looked up in the site
const RESERVED = /^\/(mcp|api|backup|tasks|account|invite|authorize|token|register|health|privacy|\.well-known)(\/|$)/;
/** What the site was built with as its address (site/astro.config.mjs): replaced by the real one when served. */
export const SITE_PLACEHOLDER = "https://site.invalid";

/** Pure: the file of the built site a path asks for, or null for one that could leave it or is the brain's. */
export function sitePath(pathname: string): string | null {
  let p: string;
  try { p = decodeURIComponent(pathname); } catch { return null; }
  if (!p.startsWith("/") || p.includes("\0") || RESERVED.test(p) || p.split("/").some((s) => s === ".." || s === ".")) return null;
  if (p.endsWith("/")) return `${p.slice(1)}index.html`;
  return /\.[a-z0-9]+$/i.test(p) ? p.slice(1) : `${p.slice(1)}/index.html`;
}

/** Pure: a page of the site with this instance's particulars in place of its placeholders. An HTML
 *  body is kept from Cloudflare's email obfuscation, whose decoding script the CSP would block. */
export function fillSite(text: string, s: Site, html = true): string {
  const contact = contactOf(s);
  const out = text
    .replaceAll(SITE_PLACEHOLDER, () => s.siteUrl)
    .replaceAll("__APP__", () => esc(s.url))
    .replaceAll("mailto:__CONTACT__", () => contact ? `mailto:${contact}` : `${esc(s.url)}/privacy`)
    .replaceAll("__OPERATOR__", () => esc(s.operator));
  return html ? out.replace(/<body[^>]*>/, "$&<!--email_off-->").replace("</body>", "<!--/email_off--></body>") : out;
}

/** Pure: how long a file of the site may be kept. */
export function siteCache(rel: string): string {
  if (rel.startsWith("_astro/")) return "public, max-age=31536000, immutable"; // named by their hash
  if (rel.endsWith(".html") || rel.endsWith(".xml") || rel.endsWith(".txt")) return "no-cache";
  return "public, max-age=2592000";
}

/** A file of the built site in `dir`, or null when there is none. */
export async function siteFile(dir: string, pathname: string, s: Site, status = 200): Promise<Response | null> {
  const rel = sitePath(pathname);
  if (rel === null) return null;
  const bytes = await Deno.readFile(`${dir}/${rel}`).catch(() => null);
  if (!bytes) return null;
  const ext = rel.slice(rel.lastIndexOf(".") + 1).toLowerCase();
  const headers: Record<string, string> = {
    "content-type": TYPES[ext] ?? "application/octet-stream", "cache-control": siteCache(rel),
    "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin",
  };
  if (ext === "svg") headers["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  if (ext === "xml" || ext === "txt") return new Response(fillSite(new TextDecoder().decode(bytes), s, false), { status, headers });
  if (ext !== "html") return new Response(bytes, { status, headers });
  return new Response(fillSite(new TextDecoder().decode(bytes), s), { status, headers: { ...headers, "content-security-policy": SITE_CSP, "x-frame-options": "DENY" } });
}

/** Where a request on the brain's address goes when the site has an address of its own: the same
 *  path there when it is one of the site's, null when it is the brain's. */
export async function siteMoved(dir: string, u: URL, s: Site): Promise<string | null> {
  if (s.siteUrl === s.url) return null;
  const rel = sitePath(u.pathname);
  if (rel === null) return null;
  const there = await Deno.stat(`${dir}/${rel}`).then((f) => f.isFile).catch(() => false);
  return there ? `${s.siteUrl}${u.pathname}${u.search}` : null;
}
