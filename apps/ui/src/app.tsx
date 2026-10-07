// app.tsx — the shell: the rail, the top bar with the live state, and the page on screen. Pages are
// added here as they move over from apps/cli/dashboard.

import { live } from "./state.ts";
import { t } from "./i18n.ts";
import { Health } from "./pages/health.tsx";

export function App() {
  const state = live.value;
  return (
    <div class="app">
      <aside class="rail">
        <div class="brand">claude-multi</div>
        <nav aria-label="Sections">
          <a href="#system" aria-current="page">
            <svg viewBox="0 0 24 24">
              <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
              <circle cx="16" cy="6" r="2" />
              <circle cx="10" cy="12" r="2" />
              <circle cx="18" cy="18" r="2" />
            </svg>
            {/* data-i18n: the shared style sheet hides the label by it when the rail keeps only icons */}
            <span data-i18n="nav.system">{t("nav.system")}</span>
          </a>
        </nav>
      </aside>
      <div class="main">
        <header class="top">
          <div class="top-t">
            <span class="eyebrow">{t("nav.system")}</span>
            <h1>{t("health.checks")}</h1>
          </div>
          <div class={`live${state === "live" ? "" : ` ${state}`}`}>
            <span class="pulse" />
            <span>{t(`live.${state}`)}</span>
          </div>
        </header>
        <section class="view">
          <Health />
        </section>
      </div>
    </div>
  );
}
