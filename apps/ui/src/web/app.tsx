// app.tsx — the web app's frame: one column, a view at a time, the tab bar under it. A conversation takes
// the whole screen (its composer is where the keyboard is).

import { route } from "./route.ts";
import { t } from "./t.ts";
import type { View } from "./lib.ts";
import { Conversation, ChatList } from "./chat.tsx";
import { Tasks } from "./tasks.tsx";
import { Brain } from "./brain.tsx";
import { Machines } from "./machines.tsx";
import { Settings } from "./settings.tsx";

const TABS: { view: View; label: () => string; icon: string }[] = [
  { view: "chat", label: () => t("tab.chat"), icon: "M4 5h16v11H9l-5 4z" },
  { view: "tasks", label: () => t("tab.tasks"), icon: "M5 12l4 4 10-10" },
  { view: "brain", label: () => t("tab.brain"), icon: "M12 4a6 6 0 0 0-6 6c0 2 1 3 2 4v3h8v-3c1-1 2-2 2-4a6 6 0 0 0-6-6z" },
  { view: "machines", label: () => t("tab.machines"), icon: "M4 6h16v9H4zM9 19h6" },
  { view: "settings", label: () => t("tab.settings"), icon: "M4 7h16M4 12h16M4 17h16" },
];

function Tabs() {
  const here = route.value.view;
  return (
    <nav class="tabs" aria-label={t("tab.nav")}>
      {TABS.map((x) => (
        <a key={x.view} href={`#${x.view}`} class={x.view === here ? "on" : ""} aria-current={x.view === here ? "page" : undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={x.icon} /></svg>
          <span>{x.label()}</span>
        </a>
      ))}
    </nav>
  );
}

export function App() {
  const r = route.value;
  if (r.view === "chat" && r.id) return <Conversation key={r.id} id={r.id} />;
  return (
    <div class="shell">
      <main>
        {r.view === "chat" && <ChatList />}
        {r.view === "tasks" && <Tasks />}
        {r.view === "brain" && <Brain key={r.id ?? ""} path={r.id} />}
        {r.view === "machines" && <Machines />}
        {r.view === "settings" && <Settings />}
      </main>
      <Tabs />
    </div>
  );
}
