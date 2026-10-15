// app.tsx — the web app's frame: a bottom tab bar on a phone (a rail on a wide screen), the views side by side in a
// pager you can swipe, and the chat list beside the conversation when there is room. The frame is one screen high and
// nothing in it scrolls but the panes, so a page whose content fits never moves. A conversation takes the whole phone
// screen: its composer is where the keyboard is.

import { go, route } from "./route.ts";
import { t } from "./t.ts";
import { tabOf, type View } from "./lib.ts";
import { ChatList, Conversation, Pick } from "./chat.tsx";
import { Tasks } from "./tasks.tsx";
import { Brain } from "./brain.tsx";
import { Machines } from "./machines.tsx";
import { More } from "./more.tsx";
import { WaitingView } from "./waiting.tsx";
import { offline, pendingCount, wide } from "./state.ts";
import { Pager, type Entry } from "./pager.tsx";
import { Icon, type IconName, Mark, OfflineBanner, Toasts } from "./ui.tsx";

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

/** The view a pane shows. A tab's own pane shows its root; the pane you are on shows the route (a brain page, Machines). */
function Screen({ e }: { e: Entry }) {
  switch (e.view) {
    case "chat":
      return <div class="col"><ChatList /></div>;
    case "waiting":
      return <div class="col"><WaitingView /></div>;
    case "tasks":
      return <div class="col"><Tasks /></div>;
    case "brain":
      return <div class="col"><Brain key={e.id ?? ""} path={e.id} /></div>;
    case "machines":
      return <div class="col"><Machines /></div>;
    default:
      return <div class="col"><More /></div>;
  }
}

const TAB_VIEWS = TABS.map((x) => x.view);

export function App() {
  const r = route.value;
  const convo = r.view === "chat" && !!r.id;
  // a conversation fills the phone; a wide screen always shows the list beside it
  const split = r.view === "chat" && (convo || wide.value);
  return (
    <div class="app" data-view={r.view} data-convo={convo} data-offline={offline.value}>
      <OfflineBanner />
      <div class="shell">
        <div class="body">
          {split
            ? (
              <main class="chat-split" data-open={convo} id="main">
                <aside class="chat-list scroller" aria-label={t("chat.title")}><ChatList active={r.id} /></aside>
                <section class="chat-pane">{r.id ? <Conversation key={r.id} id={r.id} /> : <Pick />}</section>
              </main>
            )
            : (
              <main class="pager-wrap" id="main">
                <Pager
                  here={{ key: r.view, view: r.view, id: r.id }}
                  tabs={TAB_VIEWS}
                  render={(e) => <Screen e={e} />}
                  onGo={(view) => go({ view })}
                />
              </main>
            )}
          <Toasts />
        </div>
        <Tabs />
      </div>
    </div>
  );
}
