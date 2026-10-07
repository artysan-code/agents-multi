// The local page: shown while the console does not answer. It asks GET /api/code on the console's
// port (given by the app in ?port=) and navigates there once it answers, to the view in ?view= (a
// fragment: #system/health, #pick); until then it says so and
// keeps trying. The request is no-cors: the console sends no CORS headers, and an opaque answer is
// enough to know it is up. The page has no IPC: it needs nothing from the app.

const INTERVAL_MS = 2000;
const TIMEOUT_MS = 1500;

function code(s) {
  const el = document.createElement("code");
  el.textContent = s;
  return el;
}

const it = navigator.language.toLowerCase().startsWith("it");
const text = it
  ? {
    checking: "Connessione alla console…",
    unreachable: "La console non risponde.",
    noAnswer: "Nessuna risposta da",
    startWith: "Avviala con",
    keepsTrying: "questa pagina riprova da sola.",
    retry: "Riprova",
  }
  : {
    checking: "Connecting to the console…",
    unreachable: "The console is not reachable.",
    noAnswer: "No answer from",
    startWith: "Start it with",
    keepsTrying: "this page keeps trying.",
    retry: "Retry",
  };

// the app always passes the port; 7331 is the default it would have resolved anyway
const params = new URLSearchParams(location.search);
const given = Number(params.get("port"));
const port = Number.isInteger(given) && given > 0 && given < 65536 ? given : 7331;
const consoleUrl = `http://127.0.0.1:${port}/`;
// the same rule as the app's (flags::is_view): lowercase words and slashes
const view = /^[a-z0-9/-]{1,64}$/.test(params.get("view") ?? "") ? params.get("view") : "";

const main = document.querySelector("main");
const status = document.getElementById("status");
const hint = document.getElementById("hint");
const retry = document.getElementById("retry");
retry.textContent = text.retry;
status.textContent = text.checking;

let timer = 0;
let busy = false;

async function reachable() {
  try {
    await fetch(`${consoleUrl}api/code`, {
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

async function check() {
  if (busy) return;
  busy = true;
  retry.disabled = true;
  clearTimeout(timer);
  if (await reachable()) {
    location.replace(view ? `${consoleUrl}#${view}` : consoleUrl);
    return;
  }
  main.dataset.state = "unreachable";
  status.textContent = text.unreachable;
  hint.replaceChildren(
    `${text.noAnswer} ${consoleUrl}. ${text.startWith} `,
    code("agents serve"),
    `; ${text.keepsTrying}`,
  );
  hint.hidden = false;
  retry.hidden = false;
  retry.disabled = false;
  busy = false;
  timer = setTimeout(check, INTERVAL_MS);
}

retry.addEventListener("click", check);
check();
