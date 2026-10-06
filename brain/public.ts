// public.ts — the two pages anyone can open without an account: the landing on `/`, saying what the
// service is and where to sign in, and `/privacy`, the privacy notice. The notice covers this service
// and claude-multi's Google integration, since its OAuth client points here (Google wants a public
// notice for it). Who runs the instance, how to reach them and where it is hosted come from the
// environment (BRAIN_OPERATOR, BRAIN_CONTACT, BRAIN_HOSTING): nothing about one person is written here.

import { esc, page } from "./pages.ts";

export interface Site {
  url: string;
  /** who runs this instance: the data controller */
  operator: string;
  /** an address that reaches them; empty when not set */
  contact: string;
  /** where the server is, in a sentence fragment ("un server in un datacenter europeo") */
  hosting: string;
}

/** When the notice last changed: bump it with every change of substance. */
export const PRIVACY_UPDATED = "6 ottobre 2026";

const GOOGLE_SCOPES: [string, string][] = [
  ["gmail.readonly", "leggere e cercare la posta"],
  ["gmail.compose", "scrivere bozze e inviarle, solo quando lo chiedi tu"],
  ["calendar.events", "leggere gli eventi e crearli o modificarli"],
  ["calendar.calendarlist.readonly", "sapere quali calendari hai"],
  ["drive.readonly", "cercare e leggere i file di Drive, senza modificarli"],
];

const contactLine = (s: Site) =>
  s.contact ? `<a href="mailto:${esc(s.contact)}">${esc(s.contact)}</a>` : "l'amministratore del servizio";

const footer = (here: "home" | "privacy") => `
  <p class="foot">${here === "home" ? `<a href="/privacy">Privacy</a>` : `<a href="/">Brain</a>`} · <a href="/tasks">Bacheca</a> · <a href="/account">Account</a></p>`;

export function landingPage(s: Site) {
  return page("Brain", `<article class="doc">
  <h1>Brain</h1>
  <p>La memoria e le task di chi lo usa, in un posto solo, raggiunte da ogni Claude: le app, claude.ai, Claude Code e Claude Desktop.</p>
  <ul class="list">
    <li><b>Memoria</b>: pagine in Markdown collegate tra loro, con la storia di ogni modifica.</li>
    <li><b>Task</b>: una lista sola, con la bacheca anche dal telefono.</li>
    <li><b>Ricerca</b>: per parole e per significato, calcolata su questo server.</li>
    <li><b>Separato per persona</b>: ognuno ha il suo database e la sua chiave per le copie.</li>
  </ul>
  <p>È un servizio privato di ${esc(s.operator)}: gli account esistono solo su invito, e si entra con passphrase e codice dell'app di autenticazione.</p>
  <div class="row cta"><a class="btn" href="/tasks">Entra</a><a class="btn ghost" href="/account">Il tuo account</a></div>
  ${footer("home")}</article>`, true);
}

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
  <p>Il token di accesso resta nel tuo computer, in un archivio cifrato. Quello che legge va solo alla tua conversazione con Claude, per rispondere a quello che hai chiesto: non viene salvato su questo server né altrove, non viene usato per pubblicità, non viene venduto, non serve ad addestrare modelli di intelligenza artificiale, e nessuno lo legge se non tu.</p>
  <p>L'uso e il trasferimento ad altre applicazioni delle informazioni ricevute dalle API di Google rispettano le <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, compresi i requisiti di Limited Use. Puoi togliere l'accesso in qualsiasi momento da <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.</p>

  <h2>Perché, e per quanto</h2>
  <p>I dati servono a darti il servizio che hai chiesto (art. 6.1.b GDPR); i log a tenerlo sicuro (interesse legittimo, art. 6.1.f). Restano finché l'account esiste; i log per il tempo che serve a capire un problema.</p>

  <h2>I tuoi diritti</h2>
  <p>Puoi chiedere di vedere, correggere, esportare o cancellare i tuoi dati, e opporti al trattamento, scrivendo a ${contactLine(s)}. Puoi anche rivolgerti all'autorità di controllo del tuo paese (in Italia, il <a href="https://www.garanteprivacy.it">Garante per la protezione dei dati personali</a>).</p>
  ${footer("privacy")}</article>`, true);
}
