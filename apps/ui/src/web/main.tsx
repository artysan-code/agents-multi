// main.tsx — boots the web app (web.html): the style sheet, the service worker, the app.

import { render } from "preact";
import "./web.css";
import { App } from "./app.tsx";
import { listenForOpen } from "./route.ts";

render(<App />, document.getElementById("root")!);

// the shell and push only (public/sw.js); a browser without it still runs the app
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(() => {});
  listenForOpen();
}
