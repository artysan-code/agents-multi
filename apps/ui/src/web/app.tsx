// app.tsx — the web app's frame: a bottom tab bar on a phone (a rail on a wide screen), one view at a time, and
// the chat list beside the conversation when there is room. A conversation takes the whole phone screen: its
// composer is where the keyboard is.

import { route } from "./route.ts";
import { t } from "./t.ts";
import { tabOf, type View } from "./lib.ts";
import { ChatList, Conversation, Pick } from "./chat.tsx";
import { Tasks } from "./tasks.tsx";
import { Brain } from "./brain.tsx";
import { Machines } from "./machines.tsx";
import { More } from "./more.tsx";
import { WaitingView } from "./waiting.tsx";
import { pendingCount } from "./state.ts";
import { Icon, type IconName, Mark, OfflineBanner } from "./ui.tsx";

const TABS: { view: View; label: () => string; icon: IconName }[] = [
  { view: "chat", label: () => t("tab.chat"), icon: "chat" },
  { view: "waiting", label: () => t("tab.waiting"), icon: "waiting" },
  { view: "tasks", label: () => t("tab.tasks"), icon: "tasks" },
  { view: "brain", label: () => t("tab.brain"), icon: "brain" },
  { view: "more", label: () => t("tab.more"), icon: "more" },
];

function Tabs() {
  const here = tabOf(route.value.view);
  const n = pendingCount.value;
  return (
    <nav class="tabs" aria-label={t("tab.nav")}>
      <span class="rail-mark" aria-hidden="true"><Mark size={30} /></span>
      {TABS.map((x) => (
        <a key={x.view} href={`#${x.view}`} class={x.view === here ? "on" : ""} aria-current={x.view === here ? "page" : undefined}>
          <span class="tab-i">
            <Icon name={x.icon} />
            {x.view === "waiting" && n > 0 && <b class="badge-n" aria-label={t("tab.pending", { n })}>{n > 9 ? "9+" : n}</b>}
          </span>
          <span class="tab-l">{x.label()}</span>
        </a>
      ))}
    </nav>
  );
}

export function App() {
  const r = route.value;
  const convo = r.view === "chat" && !!r.id;
  return (
    <div class="app" data-view={r.view} data-convo={convo}>
      <OfflineBanner />
      <Tabs />
      {r.view === "chat"
        ? (
          <main class="chat-split" data-open={convo} id="main">
            <aside class="chat-list" aria-label={t("chat.title")}><ChatList active={r.id} /></aside>
            <section class="chat-pane">{r.id ? <Conversation key={r.id} id={r.id} /> : <Pick />}</section>
          </main>
        )
        : (
          <main class="col" id="main" key={r.view}>
            {r.view === "waiting" && <WaitingView />}
            {r.view === "tasks" && <Tasks />}
            {r.view === "brain" && <Brain key={r.id ?? ""} path={r.id} />}
            {r.view === "more" && <More />}
            {r.view === "machines" && <Machines />}
          </main>
        )}
    </div>
  );
}
