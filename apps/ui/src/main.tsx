// main.tsx — boots the new console: the shared style sheet of the current one, whose console this is
// (before the tasks draw: it says which are "mine"), the report, the live connection, then the shell;
// or, at #pick, the profile picker alone, and at #hey «Hey Claude» alone; on a machine not set up yet,
// the first-run wizard.

import { render } from "preact";
import "./styles/base.css";
import "./styles/v2.css";
import { App } from "./app.tsx";
import { loadSetup } from "./pages/setup/api.ts";
import { connect, loadOwner, loadStatus } from "./state.ts";
import { go } from "./router.ts";
import { t } from "./i18n.ts";
import { toast } from "./lib/ui.tsx";
import "./shell/prefs.ts";
import { dismissBoot } from "./shell/boot.tsx";

// Claude's faces come from the Desktop bundle the server scans, not from the build
const faces = document.createElement("link");
faces.rel = "stylesheet";
faces.href = "/claude/faces.css";
document.head.append(faces);

// «Which Claude?» (#pick) and «Hey Claude» (#hey) are pages of their own, without the console's frame:
// the desktop app shows each in a small window
// (the start screen is the console's: they go without it)
if (location.hash === "#pick") {
  dismissBoot();
  const { Pick } = await import("./pages/pick/index.tsx");
  render(<Pick />, document.getElementById("root")!);
} else if (location.hash === "#hey") {
  dismissBoot();
  const { Hey } = await import("./pages/hey/index.tsx");
  render(<Hey />, document.getElementById("root")!);
} else {
  const setup = await loadSetup().catch(() => null);
  if (setup?.active) {
    // a machine with no configuration yet: the first-run wizard, in place of the console
    dismissBoot();
    const { Setup } = await import("./pages/setup/index.tsx");
    render(<Setup initial={setup} />, document.getElementById("root")!);
  } else {
    go(location.hash.slice(1));
    await loadOwner();
    render(<App />, document.getElementById("root")!);
    loadStatus().catch((e: Error) => toast(t("err.server", { e: e.message }), true));
  }
  connect();
}
