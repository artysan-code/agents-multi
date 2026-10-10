// app.tsx — the shell: the rail with every page (shell/rail.tsx), the bar to ask Claude where there is
// something to ask about, the page on screen, and the overlays (drawer, toast, palette, update wizard,
// the start screen).

import type { FunctionComponent } from "preact";
import { useEffect } from "preact/hooks";
import { view, type View } from "./router.ts";
import { Overlays } from "./lib/ui.tsx";
import { ask, askContext, AskBar } from "./shell/ask.tsx";
import { Rail } from "./shell/rail.tsx";
import { Boot } from "./shell/boot.tsx";
import { PaletteHost } from "./shell/palette.tsx";
import { lazy } from "./lib/lazy.tsx";
import { Today } from "./pages/today/index.tsx";
import { Tasks } from "./pages/tasks/index.tsx";
import { closeScreen } from "./pages/system/close-plan.ts";

// the pages Today and the shell do not need to draw come in their own chunks, when first shown
const Brain = lazy(() => import("./pages/brain/index.tsx").then((m) => m.Brain));
const Connections = lazy(() => import("./pages/connections/index.tsx").then((m) => m.Connections));
const System = lazy(() => import("./pages/system/index.tsx").then((m) => m.System));
const UpdateWizardHost = lazy(() => import("./pages/system/wizard.tsx").then((m) => m.UpdateWizardHost));
const CloseClaudeHost = lazy(() => import("./pages/system/updates-close.tsx").then((m) => m.CloseClaudeHost));

const PAGES: Record<View, FunctionComponent> = {
  today: Today,
  tasks: Tasks,
  brain: Brain,
  connections: Connections,
  system: System,
};

export function App() {
  const v = view.value;
  const Page = PAGES[v];
  // the bar asks for a new task in a project only on Tasks, and for changes to the brain only on Brain
  useEffect(() => {
    const k = ask.value.kind;
    if ((k === "newtask" && v !== "tasks") || (k === "brain" && v !== "brain")) askContext("ask");
  }, [v]);
  return (
    <div class="v2">
      <Rail />
      <div class="v2-main">
        {(v === "today" || v === "tasks" || v === "brain") && <AskBar />}
        <section id={`v-${v}`} class={`view${v === "brain" ? " wide" : ""}`}>
          <Page />
        </section>
      </div>
      <Overlays />
      <PaletteHost />
      <UpdateWizardHost />
      {closeScreen.value && <CloseClaudeHost />}
      <Boot />
    </div>
  );
}
