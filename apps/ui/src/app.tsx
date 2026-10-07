// app.tsx — the shell: the rail with the sections, the state line and the viewer's preferences; the top
// bar with the title and the live state; the page on screen; the field to ask Claude where there is
// something to ask about; and the overlays (drawer, toast, palette, update wizard).

import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { live, status, summary } from "./state.ts";
import { lang, langPref, t } from "./i18n.ts";
import { view, type View } from "./router.ts";
import { AIcon } from "./lib/claude.tsx";
import { Overlays } from "./lib/ui.tsx";
import { ask, askContext, AskDock } from "./shell/ask.tsx";
import { PaletteHost, paletteOpen } from "./shell/palette.tsx";
import { cycleLang, cycleTheme, theme } from "./shell/prefs.ts";
import { Today } from "./pages/today/index.tsx";
import { Tasks } from "./pages/tasks/index.tsx";
import { Brain } from "./pages/brain/index.tsx";
import { Connections } from "./pages/connections/index.tsx";
import { System } from "./pages/system/index.tsx";
import { UpdateWizardHost } from "./pages/system/wizard.tsx";

const PAGES: Record<View, () => ComponentChildren> = {
  today: Today,
  tasks: Tasks,
  brain: Brain,
  connections: Connections,
  system: System,
};

/** The rail's icons: an Anthropicons glyph when Desktop's font is here, else these. */
const NAV: { v: View; glyph: string; icon: ComponentChildren }[] = [
  {
    v: "today",
    glyph: "Sun",
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    ),
  },
  {
    v: "tasks",
    glyph: "Tasks",
    icon: (
      <svg viewBox="0 0 24 24">
        <rect x="3" y="4" width="5" height="16" rx="1.5" />
        <rect x="10" y="4" width="5" height="10" rx="1.5" />
        <rect x="17" y="4" width="4" height="13" rx="1.5" />
      </svg>
    ),
  },
  {
    v: "brain",
    glyph: "Memory",
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="8" r="2.5" />
        <circle cx="10" cy="18" r="2.5" />
        <path d="M8.3 7l7.4.7M7 8.3l2.2 7.4M16.6 10l-4.9 6" />
      </svg>
    ),
  },
  {
    v: "connections",
    glyph: "Connectors",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M9 7V3M15 7V3M7 7h10v5a5 5 0 0 1-10 0z" />
        <path d="M12 17v4" />
      </svg>
    ),
  },
  {
    v: "system",
    glyph: "Settings",
    icon: (
      <svg viewBox="0 0 24 24">
        <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
        <circle cx="16" cy="6" r="2" />
        <circle cx="10" cy="12" r="2" />
        <circle cx="18" cy="18" r="2" />
      </svg>
    ),
  },
];

function Rail() {
  const sum = summary.value;
  const level = sum ? sum.level : "down";
  const fails = sum?.fails.length ?? 0;
  const pref = langPref.value;
  return (
    <aside class="rail">
      <div class="brand">Agents Multi</div>
      <nav aria-label="Sections">
        {NAV.map(({ v, glyph, icon }) => (
          <a key={v} href={`#${v}`} aria-current={view.value === v ? "page" : undefined} title={t(`nav.${v}`)}>
            <AIcon name={glyph} fallback={icon} />
            {/* data-i18n: the shared style sheet hides the label by it when the rail keeps only icons */}
            <span data-i18n={`nav.${v}`}>{t(`nav.${v}`)}</span>
            {v === "system" && <span class={`n${fails ? " crit" : ""}`}>{fails || ""}</span>}
          </a>
        ))}
      </nav>
      <div class="rail-foot">
        <a class={`state-line ${level}`} href="#system/health">
          <i />
          <span>{t(`state.${level}`)}</span>
        </a>
        <button type="button" class="kbd" onClick={() => (paletteOpen.value = true)}>
          <svg viewBox="0 0 24 24" class="ico">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <span>{t("rail.search")}</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div class="prefs">
          <button type="button" class="kbd" title={t("rail.theme")} onClick={cycleTheme}>
            <svg viewBox="0 0 24 24" class="ico">
              <circle cx="12" cy="12" r="8" />
              <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" />
            </svg>
            <span>{t(`theme.${theme.value}`)}</span>
          </button>
          <button type="button" class="kbd" title={t("rail.lang")} onClick={cycleLang}>
            <svg viewBox="0 0 24 24" class="ico">
              <circle cx="12" cy="12" r="8" />
              <path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16" />
            </svg>
            <span>{pref === "auto" ? `${t("lang.auto")} · ${lang().toUpperCase()}` : pref.toUpperCase()}</span>
          </button>
        </div>
      </div>
    </aside>
  );
}

function Top() {
  const v = view.value;
  const state = live.value;
  // Today greets, as Claude does; the date heads the day below
  const h = new Date().getHours();
  const title = v === "today"
    ? t(`greet.${h < 5 ? "night" : h < 13 ? "morning" : h < 18 ? "afternoon" : "evening"}`)
    : t(`title.${v}`);
  return (
    <header class="top">
      <div class="top-t">
        {v !== "today" && <span class="eyebrow">{status.value?.machine.hostname ?? ""}</span>}
        <h1>{title}</h1>
      </div>
      <div class={`live${state === "live" ? "" : ` ${state}`}`}>
        <span class="pulse" />
        <span>{t(`live.${state}`)}</span>
      </div>
    </header>
  );
}

export function App() {
  const v = view.value;
  const Page = PAGES[v];
  // the field asks for a new task only on Tasks, and for changes to the brain only on Brain
  useEffect(() => {
    const k = ask.value.kind;
    if ((k === "newtask" && v !== "tasks") || (k === "brain" && v !== "brain")) askContext("ask");
  }, [v]);
  return (
    <div class="app">
      <Rail />
      <div class="main">
        <Top />
        <section id={`v-${v}`} class={`view${v === "brain" ? " wide" : ""}`}>
          <Page />
        </section>
        {(v === "today" || v === "tasks" || v === "brain") && <AskDock />}
      </div>
      <Overlays />
      <PaletteHost />
      <UpdateWizardHost />
    </div>
  );
}
