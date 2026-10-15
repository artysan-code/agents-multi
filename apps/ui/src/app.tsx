// app.tsx — the shell: the rail with the three views and «More» (shell/rail.tsx), the page on screen,
// and the overlays (drawer, toast, palette, update wizard, the start screen).

import type { FunctionComponent } from "preact";
import { view, type View } from "./router.ts";
import { Overlays } from "./lib/ui.tsx";
import { Rail } from "./shell/rail.tsx";
import { Boot } from "./shell/boot.tsx";
import { PaletteHost } from "./shell/palette.tsx";
import { lazy } from "./lib/lazy.tsx";
import { Chat } from "./pages/chat/index.tsx";
import { closeScreen } from "./pages/system/close-plan.ts";

// the pages Chat and the shell do not need to draw come in their own chunks, when first shown
const Runs = lazy(() => import("./pages/runs/index.tsx").then((m) => m.Runs));
const Limits = lazy(() => import("./pages/limits/index.tsx").then((m) => m.Limits));
const Connections = lazy(() => import("./pages/connections/index.tsx").then((m) => m.Connections));
const System = lazy(() => import("./pages/system/index.tsx").then((m) => m.System));
const UpdateWizardHost = lazy(() => import("./pages/system/wizard.tsx").then((m) => m.UpdateWizardHost));
const CloseClaudeHost = lazy(() => import("./pages/system/updates-close.tsx").then((m) => m.CloseClaudeHost));

const PAGES: Record<View, FunctionComponent> = {
  chat: Chat,
  runs: Runs,
  limits: Limits,
  connections: Connections,
  system: System,
};

export function App() {
  const v = view.value;
  const Page = PAGES[v];
  return (
    <div class="v2">
      <Rail />
      <div class="v2-main">
        <section id={`v-${v}`} class="view">
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
