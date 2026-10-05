// pages.ts — the pages a person sees here: signing in when Claude asks to connect, the account
// (personal tokens for their machines, the Claude connections, the backup key, and for the
// administrator the accounts and their invitations), and the invitation that creates an account.
// Claude's palette, the system's faces: nothing is loaded from elsewhere.

import type { User } from "./users.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `
:root{--bg:#fcfcfb;--card:#fff;--fg:#0b0b0b;--dim:#52514e;--faint:#75736d;--line:rgba(11,11,11,.1);--accent:#c6613f;--on:#fff;--crit:#bf4d43;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#151515;--card:#1a1a19;--fg:#f0efec;--dim:#c3c2b7;--faint:#929089;--line:rgba(240,239,236,.1);--accent:#d97757;--on:#0b0b0b;--crit:#e57a6f;color-scheme:dark}}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--fg);font:400 15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{width:min(420px,100%);background:var(--card);border-radius:18px;padding:28px;box-shadow:0 .25rem 1.25rem rgba(0,0,0,.04),0 0 0 1px var(--line)}
main.wide{width:min(640px,100%)}
h1{font:400 26px/1.2 Georgia,"Source Serif 4",serif;letter-spacing:-.01em;margin-bottom:6px}
p{color:var(--dim);font-size:14px}
form{display:flex;flex-direction:column;gap:12px;margin-top:20px}
label{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--dim)}
input{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg)}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{font:inherit;font-weight:500;padding:10px 14px;border-radius:10px;border:0;background:var(--accent);color:var(--on);cursor:pointer}
button.ghost{background:transparent;color:var(--dim);border:1px solid var(--line)}
.err{color:var(--crit);font-size:13.5px;margin-top:14px}
.token{font:13px ui-monospace,monospace;word-break:break-all;padding:12px;border-radius:10px;background:rgba(127,127,127,.1);margin-top:10px}
table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13.5px}
td{padding:8px 4px;border-top:1px solid var(--line)}
td.r{text-align:right}
h2{font:500 14px/1.2 ui-sans-serif,system-ui,sans-serif;margin-top:26px}
.row{display:flex;gap:8px;flex-wrap:wrap}.row input{flex:1;min-width:120px}
.sub{color:var(--faint);font-size:12.5px}
form.inline{display:inline;margin:0}
`;

const page = (title: string, inner: string, wide = false) =>
  `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body><main${wide ? ' class="wide"' : ""}>${inner}</main></body></html>`;

export function html(body: string, status = 200, extra: Record<string, string> = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://claude.ai https://claude.com http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
      "referrer-policy": "no-referrer", ...extra,
    },
  });
}

const signInFields = (totp: boolean) => `
  <label>Account<input name="user" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
  <label>Passphrase<input type="password" name="passphrase" autocomplete="current-password" required></label>
  ${totp ? `<label>Codice dell'app di autenticazione<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required></label>` : ""}`;

export function authorizePage(client: string, params: URLSearchParams, totp: boolean, error = "", machine = false) {
  const hidden = [...params].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return page("Collega Claude al cervello", `
  <h1>Collega ${esc(client)}</h1>
  <p>${esc(client)} chiede di leggere e scrivere nel tuo cervello: memoria e task.</p>
  ${machine ? `<p>Riceve un token che non scade e la chiave di backup, e li mette nel vault di claude-multi. Il token lo trovi e lo revochi nella pagina dell'account.</p>` : ""}
  <form method="post" action="/authorize">${hidden}${signInFields(totp)}<button>Collega</button></form>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}`);
}

export function signInPage(totp: boolean, error = "") {
  return page("Il tuo cervello", `
  <h1>Il tuo cervello</h1>
  <p>Accedi per gestire i token delle tue macchine e le connessioni di Claude.</p>
  <form method="post" action="/account/login">${signInFields(totp)}<button>Accedi</button></form>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}`);
}

const SIGNED_OUT_ERROR = "Account, passphrase o codice sbagliati.";
export { SIGNED_OUT_ERROR };

const when = (s: string | null) => s ? new Date(s).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "mai";

export interface AdminView {
  users: User[];
  /** the link just made for an account, shown once */
  link?: { id: string; url: string };
  error?: string;
}

export function accountPage(
  user: User,
  tokens: { name: string; created: string; used: string | null; hash: string }[],
  claude: { name: string; created: string; used: string | null }[],
  extra: { fresh?: { name: string; token: string }; backupKey?: string; admin?: AdminView } = {},
) {
  const { fresh, backupKey, admin } = extra;
  return page("Il tuo cervello", `
  <h1>Il cervello di ${esc(user.name)}</h1>
  <div class="sub">Account <b>${esc(user.id)}</b>${user.admin ? " · amministratore" : ""} ·
    <form method="post" action="/account/logout" class="inline"><button class="ghost" style="padding:2px 8px">Esci</button></form></div>
  ${fresh ? `<p>Il token di <b>${esc(fresh.name)}</b>. Copialo ora nel vault della macchina: non verrà più mostrato.</p><div class="token">${esc(fresh.token)}</div>` : ""}
  <h2>Token delle tue macchine</h2>
  <table>${tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>usato ${esc(when(t.used))}</td><td class="r">
    <form method="post" action="/account/revoke" style="margin:0"><input type="hidden" name="hash" value="${esc(t.hash)}"><button class="ghost">Revoca</button></form></td></tr>`).join("") || `<tr><td>nessuno</td></tr>`}</table>
  <form method="post" action="/account/token" class="row"><input name="name" placeholder="nome della macchina, es. fisso" required maxlength="60"><button>Crea token</button></form>
  <h2>Connessioni di Claude</h2>
  <table>${claude.map((c) => `<tr><td>${esc(c.name)}</td><td>dal ${esc(when(c.created))}</td><td class="r">usata ${esc(when(c.used))}</td></tr>`).join("") || `<tr><td>nessuna</td></tr>`}</table>
  <form method="post" action="/account/revoke-claude"><button class="ghost">Scollega tutte le connessioni di Claude</button></form>
  <h2>Chiave delle copie</h2>
  <p>Le tue macchine tengono copie cifrate del tuo cervello; questa chiave le apre. Arriva da sola nel vault quando una macchina accede dalla console (Connessioni › Accedi, o <code>claude-multi brain-login</code>).</p>
  ${backupKey ? `<div class="token">${esc(backupKey)}</div>` : `<form method="post" action="/account/backup-key"><button class="ghost">Mostra la chiave</button></form>`}
  ${admin ? adminSection(admin) : ""}`, true);
}

const state = (u: User) => u.disabled ? "disattivato" : u.ready ? "attivo" : "invito in attesa";

function adminSection(a: AdminView) {
  return `
  <h2>Account</h2>
  ${a.error ? `<p class="err">${esc(a.error)}</p>` : ""}
  ${a.link ? `<p>Il link per <b>${esc(a.link.id)}</b>, valido sette giorni e usabile una volta: mandalo alla persona per un canale sicuro.</p><div class="token">${esc(a.link.url)}</div>` : ""}
  <table>${a.users.map((u) => `<tr><td><b>${esc(u.id)}</b> · ${esc(u.name)}</td><td>${esc(state(u))}</td><td class="r">${u.admin ? "" : `
    <form method="post" action="/account/admin/reinvite" class="inline"><input type="hidden" name="id" value="${esc(u.id)}"><button class="ghost">Nuovo invito</button></form>
    <form method="post" action="/account/admin/${u.disabled ? "enable" : "disable"}" class="inline"><input type="hidden" name="id" value="${esc(u.id)}"><button class="ghost">${u.disabled ? "Riattiva" : "Disattiva"}</button></form>`}</td></tr>`).join("")}</table>
  <form method="post" action="/account/admin/invite" class="row">
    <input name="id" placeholder="id, es. bob" required pattern="[a-z][a-z0-9_\-]{1,30}" autocapitalize="none">
    <input name="name" placeholder="nome" required maxlength="60">
    <input name="language" placeholder="lingua, es. Italian" value="Italian" maxlength="30">
    <button>Invita</button></form>
  <p class="sub">Un nuovo invito azzera passphrase e codice dell'account (telefono perso, passphrase dimenticata); i suoi dati restano.</p>`;
}

export function invitePage(name: string, token: string, totpSecret: string, otpauth: string, error = "") {
  return page("Il tuo cervello", `
  <h1>Benvenuto, ${esc(name)}</h1>
  <p>Questo è il tuo cervello: la memoria e le task che Claude tiene per te. È tuo, separato da quello degli altri; l'amministratore del server, come per ogni server, può leggerne i dati.</p>
  <h2>1. Aggiungi l'account all'app di autenticazione</h2>
  <p>Inserisci questa chiave a mano (o apri il link dal telefono):</p>
  <div class="token">${esc(totpSecret)}</div>
  <p class="sub" style="margin-top:8px;word-break:break-all">${esc(otpauth)}</p>
  <h2>2. Scegli la passphrase</h2>
  <form method="post" action="/invite">
    <input type="hidden" name="t" value="${esc(token)}">
    <label>Passphrase (almeno 12 caratteri)<input type="password" name="passphrase" autocomplete="new-password" minlength="12" required></label>
    <label>Ripetila<input type="password" name="again" autocomplete="new-password" minlength="12" required></label>
    <label>Il codice che mostra l'app<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required></label>
    <button>Crea l'account</button>
  </form>
  ${error ? `<p class="err">${esc(error)}</p>` : ""}`);
}

export function invitedPage(id: string, error = "") {
  return page("Il tuo cervello", error
    ? `<h1>Invito non valido</h1><p class="err">${esc(error)}</p>`
    : `<h1>Fatto</h1><p>L'account <b>${esc(id)}</b> è pronto. Collega Claude a questo indirizzo con <code>/mcp</code>, oppure entra nella <a href="/account">pagina dell'account</a> per i token delle tue macchine.</p>`);
}
