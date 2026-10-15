// main.tsx — boots the web app (web.html): the theme, the style sheet, the service worker, the app.

import { render } from "preact";
import "./web.css";
import { applyTheme } from "./theme.ts";
import { App } from "./app.tsx";
import { listenForOpen } from "./route.ts";
import { watchWaiting } from "./state.ts";

applyTheme();

// the height the keyboard leaves: the conversation fills exactly that, so the composer sits on the keyboard
const vv = window.visualViewport;
if (vv) {
  const fit = () => {
    document.documentElement.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
    if (vv.height < innerHeight - 80) scrollTo(0, 0);
  };
  vv.addEventListener("resize", fit);
  fit();
}

render(<App />, document.getElementById("root")!);
watchWaiting();

// the shell and push only (public/sw.js); a browser without it still runs the app
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
  listenForOpen();
}
