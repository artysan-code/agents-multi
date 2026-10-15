// sw.js — the web app's service worker (ADR 0014). Two jobs and nothing else:
//   - the app shell: the page and its hashed files, kept so the app opens when the network is slow or gone.
//     No data is cached: /api and every other path go straight to the network, so nothing offline is stale.
//   - push: shows the notification of a Web Push message, and a tap on it opens (or brings forward) the app
//     on the chat it names.
// Plain JavaScript on purpose: it is served as it is, from /app/sw.js, so a new build reaches the phone at
// once. The payload (JSON): {title, body, chat?, tag?}; a plain-text payload is the body.

const SHELL = "am-shell-v1";
const BASE = new URL("./", self.location).pathname; // /app/

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== SHELL).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** Whether a request is for a file of the shell: the page (navigations) or a hashed file under assets/, the
 *  icons and the manifest. Never the service worker itself, never the API. */
function inShell(url, request) {
  if (url.origin !== self.location.origin || request.method !== "GET") return false;
  if (!url.pathname.startsWith(BASE) || url.pathname === `${BASE}sw.js`) return false;
  return request.mode === "navigate" || /\.(?:js|css|woff2|png|svg|webmanifest)$/.test(url.pathname);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!inShell(url, event.request)) return;
  const page = event.request.mode === "navigate";
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const key = page ? BASE : event.request;
    // the hashed files never change under their name: the copy kept is the answer
    if (!page && url.pathname.startsWith(`${BASE}assets/`)) {
      const hit = await cache.match(key);
      if (hit) return hit;
    }
    try {
      const res = await fetch(event.request);
      // only a real answer is kept: not the sign-in page a signed-out visit was redirected to
      if (res.ok && !res.redirected && res.type === "basic") cache.put(key, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(key);
      if (hit) return hit;
      throw e;
    }
  })());
});

function notificationOf(data) {
  let p = {};
  try {
    p = data ? data.json() : {};
  } catch {
    p = { body: data ? data.text() : "" };
  }
  const chat = typeof p.chat === "string" && p.chat ? p.chat : null;
  return {
    title: typeof p.title === "string" && p.title ? p.title : "Agents Multi",
    options: {
      body: typeof p.body === "string" ? p.body : "",
      icon: `${BASE}icons/icon-192.png`,
      badge: `${BASE}icons/icon-192.png`,
      // one notification per event: a repeated tag replaces the one already shown
      tag: typeof p.tag === "string" ? p.tag : chat ? `chat-${chat}` : undefined,
      data: { hash: chat ? `#chat/${encodeURIComponent(chat)}` : "#chat" },
    },
  };
}

self.addEventListener("push", (event) => {
  const n = notificationOf(event.data);
  event.waitUntil(self.registration.showNotification(n.title, n.options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const hash = (event.notification.data && event.notification.data.hash) || "#chat";
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const mine = open.find((c) => new URL(c.url).pathname.startsWith(BASE));
    if (mine) {
      await mine.focus();
      mine.postMessage({ open: hash });
      return;
    }
    await self.clients.openWindow(`${BASE}${hash}`);
  })());
});
