// boot.tsx — the start screen (drawn by index.html before any script, the same as the desktop app's
// waiting page) and its two returns. At start it stays until the page has its data and has laid itself
// out, then fades: the console appears whole, never piece by piece. It comes back over the page when
// the console stops answering for more than a moment (a restart: «Reconnecting», and after a while
// that it does not answer, with how to start it), and when the page reloads on new code (`leaving`).
// An update screen open stays above it: the update tells its own restart.

import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.ts";
import { view } from "../router.ts";
import { leaving, live, status } from "../state.ts";
import { board } from "../pages/tasks/model.ts";
import mark from "../assets/mark.svg";

/** How long the console may be silent before the screen covers the page, and before it says so. */
const QUIET_MS = 2500, LOST_MS = 30000;
/** The longest the start screen waits for the page's data. */
const MAX_WAIT_MS = 8000;

/** Fades the start screen of index.html out, and removes it once faded. */
export function dismissBoot(): void {
  const el = document.getElementById("boot");
  if (!el || el.classList.contains("out")) return;
  el.classList.add("out");
  setTimeout(() => el.remove(), 450);
}

/** Two frames and a breath: what the page drew with its data is laid out and painted. A window not on
 *  screen draws no frames: there the breath alone. */
const settled = () =>
  new Promise<void>((res) => {
    setTimeout(res, 300);
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 120)));
  });

/** The pages that draw the task board want it before they show. */
const ready = () => !!status.value && (!["today", "tasks"].includes(view.value) || !!board.value);

export function Boot() {
  const [quiet, setQuiet] = useState<"" | "reconnect" | "lost">("");
  const ok = ready();

  // the first start: away when the page is ready (or has waited long enough)
  useEffect(() => {
    const id = setTimeout(dismissBoot, MAX_WAIT_MS);
    return () => clearTimeout(id);
  }, []);
  useEffect(() => {
    if (!ok) return;
    void document.fonts.ready.then(settled).then(dismissBoot);
  }, [ok]);

  // the console silent: covered after a moment, «not answering» after a while
  const down = live.value === "down" && !!status.value;
  useEffect(() => {
    if (!down) return setQuiet("");
    const a = setTimeout(() => setQuiet("reconnect"), QUIET_MS);
    const b = setTimeout(() => setQuiet("lost"), LOST_MS);
    return () => (clearTimeout(a), clearTimeout(b));
  }, [down]);

  const shown = leaving.value || !!quiet;
  return (
    <div
      class={`boot${leaving.value ? "" : " cover"}${shown ? "" : " out"}`}
      role="status"
      aria-hidden={!shown}
    >
      <div class="boot-in">
        <img src={mark} alt="" />
        <div>Agents Multi</div>
        {quiet !== "lost" && <div class="boot-bar" />}
        {quiet === "reconnect" && !leaving.value && <div class="boot-msg">{t("boot.reconnect")}</div>}
        {quiet === "lost" && !leaving.value && (
          <div class="boot-msg">
            {t("boot.lost")} <code>agents serve</code>
          </div>
        )}
      </div>
    </div>
  );
}
