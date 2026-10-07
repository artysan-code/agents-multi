// main.tsx — boots the new console: the shared style sheet of the current one, whose console this is
// (before the tasks draw: it says which are "mine"), the report, the live connection, then the shell;
// or, at #pick, the profile picker alone.

import { render } from "preact";
import "../../cli/dashboard/style.css";
import { App } from "./app.tsx";
import { Pick } from "./pages/pick/index.tsx";
import { connect, loadOwner, loadStatus } from "./state.ts";
import { loadClaude } from "./lib/claude.tsx";
import { go } from "./router.ts";
import { t } from "./i18n.ts";
import { toast } from "./lib/ui.tsx";
import "./shell/prefs.ts";

// Claude's faces come from the Desktop bundle the server scans, not from the build
const faces = document.createElement("link");
faces.rel = "stylesheet";
faces.href = "/claude/faces.css";
document.head.append(faces);

// «Which Claude?» (#pick) is a page of its own, without the console's frame: the desktop app shows it
// in a small window
if (location.hash === "#pick") {
  render(<Pick />, document.getElementById("root")!);
} else {
  go(location.hash.slice(1));
  void loadClaude();
  await loadOwner();
  render(<App />, document.getElementById("root")!);
  loadStatus().catch((e: Error) => toast(t("err.server", { e: e.message }), true));
  connect();
}
