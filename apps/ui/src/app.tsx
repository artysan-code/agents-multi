// app.tsx — the shell: the header with the main tabs and the ☰ menu (shell/frame.tsx), the bar to ask
// Claude where there is something to ask about, the page on screen, and the overlays (drawer, toast,
// palette, update wizard).

import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { view, type View } from "./router.ts";
import { Overlays } from "./lib/ui.tsx";
import { ask, askContext, AskBar } from "./shell/ask.tsx";
import { Header } from "./shell/frame.tsx";
import { PaletteHost } from "./shell/palette.tsx";
import { Today } from "./pages/today/index.tsx";
import { Tasks } from "./pages/tasks/index.tsx";
import { Brain } from "./pages/brain/index.tsx";
import { Connections } from "./pages/connections/index.tsx";
import { System } from "./pages/system/index.tsx";
import { UpdateWizardHost } from "./pages/system/wizard.tsx";
import { CloseClaudeHost } from "./pages/system/updates-close.tsx";

const PAGES: Record<View, () => ComponentChildren> = {
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
      <Header />
      <div class="v2-main">
        {(v === "today" || v === "tasks" || v === "brain") && <AskBar />}
        <section id={`v-${v}`} class={`view${v === "brain" ? " wide" : ""}`}>
          <Page />
        </section>
      </div>
      <Overlays />
      <PaletteHost />
      <UpdateWizardHost />
      <CloseClaudeHost />
    </div>
  );
}
