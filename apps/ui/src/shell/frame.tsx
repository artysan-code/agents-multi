// frame.tsx — the header over every page: the mark, the three main tabs (Today, Tasks, Brain), the
// system's pill, the clock, the palette, and the ☰ menu with what is secondary: Connections, the System
// tabs, theme, language, the keyboard shortcuts and the version.

import { useEffect, useRef, useState } from "preact/hooks";
import { type Key, langPref, setLangPref, t } from "../i18n.ts";
import { minute } from "../lib/clock.ts";
import { hhmm } from "../lib/format.ts";
import { openDrawer } from "../lib/ui.tsx";
import { go, request, tab, view } from "../router.ts";
import { status } from "../state.ts";
import { board, isOpen } from "../pages/tasks/model.ts";
import { paletteOpen } from "./palette.tsx";
import { setTheme, type Theme, theme } from "./prefs.ts";
import { sys } from "./sysstate.ts";
import { Mark } from "./mark.tsx";

const MAIN = ["today", "tasks", "brain"] as const;
/** Languages by their own names: the same in every interface language. */
const LANG_NAMES: Record<string, string> = { it: "Italiano", en: "English" };

/** What is due today or late, mine or not: the number beside «Tasks». */
function dueCount(): number | null {
  const b = board.value;
  if (!b) return null;
  return b.tasks.filter((x) =>
    isOpen(x) && x.status !== "waiting" && x.due && x.due <= b.today
  ).length;
}

function Pill() {
  const s = sys.value;
  if (!status.value) return null;
  const n = s.problems.length;
  const label = s.level === "down"
    ? t("state.down")
    : s.level === "crit" || s.level === "warn"
    ? t(s.level === "crit" ? "pill.fix" : "pill.warn", { n })
    : s.level === "up"
    ? t(s.upWord)
    : t("pill.ok");
  return (
    <button
      type="button"
      class={`pill2 ${s.level === "ok" ? "" : s.level}`}
      onClick={() => request("system.show", "today")}
    >
      <i />
      {label}
    </button>
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

export const openShortcuts = (): void =>
  openDrawer(t("keys.title"), () => <Shortcuts />);

function Menu({ close }: { close: () => void }) {
  const s = sys.value;
  const S = status.value;
  const link = (
    hash: string,
    label: string,
    opts: { sub?: boolean; small?: string; tone?: string } = {},
  ) => (
    <a
      href={`#${hash}`}
      role="menuitem"
      class={opts.sub ? "sub2" : ""}
      onClick={(e) => {
        e.preventDefault();
        go(hash);
        close();
      }}
    >
      {label}
      {opts.small && <small class={opts.tone ?? ""}>{opts.small}</small>}
    </a>
  );
  const health = s.problems.length
    ? {
      small: t("pill.fix", { n: s.problems.length }),
      tone: s.problems.some((c) => c.status === "fail") ? "crit" : "warn",
    }
    : { small: t("health.okN", { n: s.ok }) };
  const themes: Theme[] = ["auto", "light", "dark"];
  const langs = ["it", "en", "auto"];
  return (
    <div class="menu2" role="menu" aria-label={t("menu.title")}>
      <h6>{t("menu.goto")}</h6>
      {link("connections", t("nav.connections"), {
        small: t("menu.connections.sub"),
      })}
      {link("system/overview", t("nav.system"))}
      {link("system/health", t("sys.health"), { sub: true, ...health })}
      {link("system/updates", t("sys.updates"), {
        sub: true,
        small: s.pending.length ? t(s.upWord) : undefined,
        tone: "warn",
      })}
      {link("system/profiles", t("menu.profiles"), { sub: true })}
      {link("system/permissions", t("sys.permissions"), { sub: true })}
      <hr />
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
        role="menuitem"
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

export function Header() {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const v = view.value;
  const n = dueCount();

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    addEventListener("mousedown", onDown);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("mousedown", onDown);
      removeEventListener("keydown", onKey);
    };
  }, [menu]);

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

  const where = v === "connections"
    ? t("nav.connections")
    : v === "system"
    ? `${t("nav.system")} · ${t(`sys.${tab.value}`)}`
    : "";
  return (
    <header class="hd">
      <div class="hd-brand">
        <Mark />
        Agents Multi
      </div>
      <nav class="hd-tabs" aria-label={t("menu.sections")}>
        {MAIN.map((x) => (
          <a key={x} href={`#${x}`} aria-current={v === x ? "page" : undefined}>
            {t(`nav.${x}`)}
            {x === "tasks" && !!n && <span class="n">{n}</span>}
          </a>
        ))}
      </nav>
      {where && <span class="hd-where">· {where}</span>}
      <div class="hd-sp" />
      <Pill />
      <span class="hd-clock">{hhmm(minute.value)}</span>
      <button
        type="button"
        class="ib"
        title={t("hd.search")}
        aria-label={t("hd.search")}
        onClick={() => (paletteOpen.value = true)}
      >
        <svg viewBox="0 0 24 24">
          <circle cx="11" cy="11" r="6" />
          <path d="M20 20l-4.5-4.5" />
        </svg>
      </button>
      <div ref={box}>
        <button
          type="button"
          class="ib"
          aria-haspopup="menu"
          aria-expanded={menu}
          title={t("menu.title")}
          aria-label={t("menu.title")}
          onClick={() => setMenu(!menu)}
        >
          <svg viewBox="0 0 24 24">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
        {menu && <Menu close={() => setMenu(false)} />}
      </div>
    </header>
  );
}
