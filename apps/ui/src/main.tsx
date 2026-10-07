// main.tsx — boots the new console: the shared style sheet of the current one, the report, the
// live connection, then the shell.

import { render } from "preact";
import "../../cli/dashboard/style.css";
import { App } from "./app.tsx";
import { connect, loadStatus } from "./state.ts";

// Claude's faces come from the Desktop bundle the server scans, not from the build
const faces = document.createElement("link");
faces.rel = "stylesheet";
faces.href = "/claude/faces.css";
document.head.append(faces);

render(<App />, document.getElementById("root")!);
loadStatus().catch(() => {});
connect();
