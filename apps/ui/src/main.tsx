// main.tsx — boots the new console: the shared style sheet of the current one, whose console this is
// (before the tasks draw: it says which are "mine"), the report, the live connection, then the shell;
// or, at #pick, the profile picker alone, and at #hey «Hey Claude» alone; on a machine not set up yet,
// the first-run wizard.

import { render } from "preact";
import "./styles/base.css";
import "./styles/v2.css";
import { App } from "./app.tsx";
import { Pick } from "./pages/pick/index.tsx";
import { Hey } from "./pages/hey/index.tsx";
import { Setup } from "./pages/setup/index.tsx";
import { loadSetup } from "./pages/setup/api.ts";
import { connect, loadOwner, loadStatus } from "./state.ts";
import { go } from "./router.ts";
import { t } from "./i18n.ts";
import { toast } from "./lib/ui.tsx";
import "./shell/prefs.ts";

// Claude's faces come from the Desktop bundle the server scans, not from the build
const faces = document.createElement("link");
faces.rel = "stylesheet";
faces.href = "/claude/faces.css";
document.head.append(faces);

// «Which Claude?» (#pick) and «Hey Claude» (#hey) are pages of their own, without the console's frame:
// the desktop app shows each in a small window
if (location.hash === "#pick") {
  render(<Pick />, document.getElementById("root")!);
} else if (location.hash === "#hey") {
  render(<Hey />, document.getElementById("root")!);
} else {
  const setup = await loadSetup().catch(() => null);
  if (setup?.active) {
    // a machine with no configuration yet: the first-run wizard, in place of the console
    render(<Setup initial={setup} />, document.getElementById("root")!);
  } else {
    go(location.hash.slice(1));
    await loadOwner();
    render(<App />, document.getElementById("root")!);
    loadStatus().catch((e: Error) =>
      toast(t("err.server", { e: e.message }), true)
    );
  }
  connect();
}
