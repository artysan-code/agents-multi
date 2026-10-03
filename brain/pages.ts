// pages.ts — the only two pages a person sees here: signing in when Claude asks to connect, and
// the account (personal tokens for the owner's machines, the Claude connections). Claude's palette,
// the system's faces: nothing is loaded from elsewhere.

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
.row{display:flex;gap:8px}.row input{flex:1}
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
  <label>Passphrase<input type="password" name="passphrase" autocomplete="current-password" required autofocus></label>
  ${totp ? `<label>Codice dell'app di autenticazione<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" required></label>` : ""}`;

export function authorizePage(client: string, params: URLSearchParams, totp: boolean, error = "") {
  const hidden = [...params].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("");
  return page("Collega Claude al cervello", `
  <h1>Collega ${esc(client)}</h1>
  <p>${esc(client)} chiede di leggere e scrivere nel tuo cervello: memoria e task.</p>
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

const when = (s: string | null) => s ? new Date(s).toLocaleString("it-IT", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "mai";

export function accountPage(
  tokens: { name: string; created: string; used: string | null; hash: string }[],
  claude: { name: string; created: string; used: string | null }[],
  fresh?: { name: string; token: string },
) {
  return page("Il tuo cervello", `
  <h1>Il tuo cervello</h1>
  ${fresh ? `<p>Il token di <b>${esc(fresh.name)}</b>. Copialo ora nel vault della macchina: non verrà più mostrato.</p><div class="token">${esc(fresh.token)}</div>` : ""}
  <h2>Token delle tue macchine</h2>
  <table>${tokens.map((t) => `<tr><td>${esc(t.name)}</td><td>usato ${esc(when(t.used))}</td><td class="r">
    <form method="post" action="/account/revoke" style="margin:0"><input type="hidden" name="hash" value="${esc(t.hash)}"><button class="ghost">Revoca</button></form></td></tr>`).join("") || `<tr><td>nessuno</td></tr>`}</table>
  <form method="post" action="/account/token" class="row"><input name="name" placeholder="nome della macchina, es. fisso" required maxlength="60"><button>Crea token</button></form>
  <h2>Connessioni di Claude</h2>
  <table>${claude.map((c) => `<tr><td>${esc(c.name)}</td><td>dal ${esc(when(c.created))}</td><td class="r">usata ${esc(when(c.used))}</td></tr>`).join("") || `<tr><td>nessuna</td></tr>`}</table>
  <form method="post" action="/account/revoke-claude"><button class="ghost">Scollega tutte le connessioni di Claude</button></form>`, true);
}
