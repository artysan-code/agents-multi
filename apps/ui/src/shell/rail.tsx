// rail.tsx — the navigation beside every page: a strip of icons that opens over the page while the
// pointer is on it (or the keyboard is in it), so every page is one click away and none of the width is
// taken. The pages (Today, Tasks, Brain; then System's: Connections, Overview, Profiles, Permissions,
// Plugins, Updates, Health), each with its own sign (the tasks due, an update waiting, the checks that
// need someone); at the bottom the one action that can wait for you — «Update» — the console's
// reachability when it is lost, the commands, the preferences (theme, language, shortcuts) and the clock.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Key, langPref, setLangPref, t } from "../i18n.ts";
import { minute } from "../lib/clock.ts";
import { hhmm } from "../lib/format.ts";
import { openDrawer } from "../lib/ui.tsx";
import { type Tab, tab, type View, view } from "../router.ts";
import { status } from "../state.ts";
import { board, isOpen } from "../pages/tasks/model.ts";
import { UpdateNow } from "../pages/system/updates-close.tsx";
import { paletteOpen } from "./palette.tsx";
import { setTheme, type Theme, theme } from "./prefs.ts";
import { sys } from "./sysstate.ts";
import { Mark } from "./mark.tsx";

/** Languages by their own names: the same in every interface language. */
const LANG_NAMES: Record<string, string> = { it: "Italiano", en: "English" };

/** The icons, 24×24 strokes. */
const ICON: Record<string, ComponentChildren> = {
  today: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  tasks: <path d="M10 6h10M10 12h10M10 18h10M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17" />,
  brain: (
    <>
      <path d="M6 4h9a3 3 0 0 1 3 3v13H9a3 3 0 0 1-3-3z" />
      <path d="M6 17a3 3 0 0 1 3-3h9M10 8h4" />
    </>
  ),
  connections: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
  overview: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  profiles: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  permissions: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M9 12l2 2 4-4" />,
  plugins: <path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4" />,
  updates: <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />,
  health: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  update: <path d="M12 19V6M6 12l6-6 6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  prefs: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  down: (
    <path d="M12 8v5M12 16.5v.5M10.3 3.9L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
  ),
};

const Ic = ({ name }: { name: string }) => <svg viewBox="0 0 24 24" aria-hidden="true">{ICON[name]}</svg>;

/** What is due today or late, mine or not: the number beside «Tasks». */
function dueCount(): number | null {
  const b = board.value;
  if (!b) return null;
  return b.tasks.filter((x) => isOpen(x) && x.status !== "waiting" && x.due && x.due <= b.today).length;
}

/** A page in the rail: its icon, its name (shown when the rail is open), and its sign. */
function Item({ hash, icon, label, current, sign }: {
  hash: string;
  icon: string;
  label: string;
  current: boolean;
  sign?: { text?: string; tone?: string };
}) {
  return (
    <a
      href={`#${hash}`}
      class="rl-i"
      aria-current={current ? "page" : undefined}
      title={label}
    >
      <Ic name={icon} />
      <span class="rl-t">{label}</span>
      {sign && (
        <>
          <span class={`rl-s ${sign.tone ?? ""}${sign.text ? "" : " dot"}`} aria-label={sign.text}>
            {sign.text}
          </span>
          <span class={`rl-b ${sign.tone ?? ""}`} aria-hidden="true" />
        </>
      )}
    </a>
  );
}

function Shortcuts() {
  const row = (keys: string[], k: Key) => (
    <>
      <dt>{keys.map((x) => <kbd class="k2" key={x}>{x}</kbd>)}</dt>
      <dd>{t(k)}</dd>
    </>
  );
  return (
    <dl class="keys2">
      <h4 class="lbl">{t("keys.general")}</h4>
      {row(["/"], "keys.ask")}
      {row(["Alt", "M"], "keys.model")}
      {row(["Ctrl", "K"], "keys.palette")}
      {row(["Esc"], "keys.close")}
      {row(["?"], "keys.help")}
      <h4 class="lbl">{t("keys.tasks")}</h4>
      {row(["J", "K"], "keys.move")}
      {row(["↵"], "keys.expand")}
      {row(["X"], "keys.done")}
    </dl>
  );
}

export const openShortcuts = (): void => openDrawer(t("keys.title"), () => <Shortcuts />);

/** The preferences: theme, language, the shortcuts, and which console this is. */
function Prefs({ close }: { close: () => void }) {
  const S = status.value;
  const themes: Theme[] = ["auto", "light", "dark"];
  const langs = ["it", "en", "auto"];
  return (
    <div class="menu2 rl-pop" role="dialog" aria-label={t("menu.prefs")}>
      <h6>{t("menu.theme")}</h6>
      <div class="sg" role="radiogroup" aria-label={t("menu.theme")}>
        {themes.map((x) => (
          <button
            type="button"
            role="radio"
            key={x}
            aria-checked={theme.value === x}
            onClick={() => setTheme(x)}
          >
            {t(`menu.theme.${x}`)}
          </button>
        ))}
      </div>
      <h6>{t("menu.lang")}</h6>
      <div class="sg" role="radiogroup" aria-label={t("menu.lang")}>
        {langs.map((x) => (
          <button
            type="button"
            role="radio"
            key={x}
            aria-checked={langPref.value === x}
            onClick={() => setLangPref(x)}
          >
            {LANG_NAMES[x] ?? t("menu.lang.auto")}
          </button>
        ))}
      </div>
      <hr />
      <button
        type="button"
        class="mi"
        onClick={() => {
          close();
          openShortcuts();
        }}
      >
        {t("menu.keys")}
        <small>
          <kbd class="k2">?</kbd>
        </small>
      </button>
      <div class="ver">
        {t("menu.ver", {
          v: `agents-multi ${S?.repo.version ?? ""}`.trim(),
          h: S?.machine.hostname ?? "",
        })}
      </div>
    </div>
  );
}

const SYSTEM: Tab[] = [
  "overview",
  "profiles",
  "permissions",
  "plugins",
  "updates",
];
const SYS_ICON: Record<Tab, string> = {
  overview: "overview",
  profiles: "profiles",
  permissions: "permissions",
  plugins: "plugins",
  updates: "updates",
  health: "health",
};

export function Rail() {
  const [prefs, setPrefs] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const v: View = view.value;
  const s = sys.value;
  const n = dueCount();
  const down = s.level === "down";
  const fails = s.problems.some((c) => c.status === "fail");

  useEffect(() => {
    if (!prefs) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setPrefs(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPrefs(false);
    };
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [prefs]);

  // "?" outside a field: the shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (
        (e.target as Element)?.closest?.(
          "input, textarea, select, [contenteditable]",
        )
      ) return;
      e.preventDefault();
      openShortcuts();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const signOf = (x: Tab): { text?: string; tone?: string } | undefined => {
    if (!status.value) return undefined;
    if (x === "updates") return s.pending.length ? { tone: "up" } : undefined;
    if (x === "health") {
      return s.problems.length
        ? { text: String(s.problems.length), tone: fails ? "crit" : "warn" }
        : { text: t("health.okN", { n: s.ok }), tone: "ok" };
    }
    return undefined;
  };

  return (
    <nav class={`rail${prefs ? " held" : ""}`} aria-label={t("menu.sections")}>
      <div class="rl-panel" ref={box}>
        <div class="rl-brand">
          <Mark />
          <span class="rl-t">Agents Multi</span>
        </div>
        <div class="rl-g">
          {(["today", "tasks", "brain"] as const).map((x) => (
            <Item
              key={x}
              hash={x}
              icon={x}
              label={t(`nav.${x}`)}
              current={v === x}
              sign={x === "tasks" && n ? { text: String(n) } : undefined}
            />
          ))}
        </div>
        <div class="rl-g">
          <h6 class="rl-h">{t("nav.system")}</h6>
          <Item
            hash="connections"
            icon="connections"
            label={t("nav.connections")}
            current={v === "connections"}
          />
          {SYSTEM.map((x) => (
            <Item
              key={x}
              hash={`system/${x}`}
              icon={SYS_ICON[x]}
              label={t(`sys.${x}`)}
              current={v === "system" && tab.value === x}
              sign={signOf(x)}
            />
          ))}
        </div>
        <div class="rl-sp" />
        <div class="rl-g rl-foot">
          {down && (
            <a
              href="#system/health"
              class="rl-i rl-down"
              title={t("state.down")}
            >
              <Ic name="down" />
              <span class="rl-t">{t("state.down")}</span>
            </a>
          )}
          {!down && status.value && (
            <a
              href="#system/health"
              class={`rl-i rl-health ${s.problems.length ? (fails ? "crit" : "warn") : "ok"}`}
              aria-current={v === "system" && tab.value === "health" ? "page" : undefined}
              title={t("sys.health")}
            >
              <Ic name="health" />
              <span class="rl-t">
                {t("sys.health")}
                <small>
                  {s.problems.length
                    ? t(fails ? "rail.health.fix" : "rail.health.look", { n: s.problems.length })
                    : t("health.okN", { n: s.ok })}
                </small>
              </span>
            </a>
          )}
          {!down && s.pending.length > 0 && (
            <UpdateNow
              cls="rl-i rl-up"
              auto
              icon={<Ic name="update" />}
              label="rl-t"
            />
          )}
          <button
            type="button"
            class="rl-i"
            title={t("hd.search")}
            onClick={() => (paletteOpen.value = true)}
          >
            <Ic name="search" />
            <span class="rl-t">{t("hd.search")}</span>
          </button>
          <button
            type="button"
            class="rl-i"
            aria-haspopup="dialog"
            aria-expanded={prefs}
            title={t("menu.prefs")}
            onClick={() => setPrefs(!prefs)}
          >
            <Ic name="prefs" />
            <span class="rl-t">{t("menu.prefs")}</span>
          </button>
          <span class="rl-clock">{hhmm(minute.value)}</span>
        </div>
        {prefs && <Prefs close={() => setPrefs(false)} />}
      </div>
    </nav>
  );
}
