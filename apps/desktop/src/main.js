// The local page: shown while the console does not answer — at a relaunch, while the console starts. It
// looks like the console's start screen (apps/ui/index.html), so the window passes from one to the other
// without a change of scene. It asks GET /api/code on the console's port (given by the app in ?port=)
// and navigates there once it answers, to the view in ?view= (a fragment: #system/health, #pick). A
// console starting is normal: the page says nothing for a while, then that it is slow, and only later
// that it does not answer, with how to start it. The request is no-cors: the console sends no CORS
// headers, and an opaque answer is enough to know it is up. The page has no IPC: it needs nothing from
// the app.

const INTERVAL_MS = 1000;
/** When the page says the console is slow, and when that it does not answer. */
const SLOW_MS = 15000, LOST_MS = 40000;
const started = Date.now();
const TIMEOUT_MS = 1500;

function code(s) {
  const el = document.createElement("code");
  el.textContent = s;
  return el;
}

const it = navigator.language.toLowerCase().startsWith("it");
const text = it
  ? {
    slow: "La console ci mette più del solito ad avviarsi…",
    unreachable: "La console non risponde.",
    noAnswer: "Nessuna risposta da",
    startWith: "Avviala con",
    keepsTrying: "questa pagina riprova da sola.",
    retry: "Riprova",
  }
  : {
    slow: "The console is taking longer than usual to start…",
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
  const waited = Date.now() - started;
  busy = false;
  timer = setTimeout(check, INTERVAL_MS);
  if (waited < SLOW_MS) return;
  status.hidden = false;
  if (waited < LOST_MS) {
    status.textContent = text.slow;
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
}

retry.addEventListener("click", check);
check();
