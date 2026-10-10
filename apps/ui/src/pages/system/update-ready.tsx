// update-ready.tsx — the update waiting, at the top of System › Updates: what each component would move
// from and to, what is new in the app, what Desktop's restart would close, and «Update now». The rail's
// update button starts the same update without coming here.

import { Fragment } from "preact";
import { t } from "../../i18n.ts";
import { status } from "../../state.ts";
import { appUpdater, notePoints } from "../../shell/app-update.ts";
import { sys } from "../../shell/sysstate.ts";
import { UpdateNow } from "./update-now.tsx";
import { desktopNext } from "./updates-lib.tsx";
import "./update-ready.css";

/** One row per component an update would move: from → to. */
function UpdateRows() {
  const S = status.value, app = appUpdater();
  const rows: [string, string][] = [];
  if (app?.available) {
    rows.push([
      "Agents Multi",
      `${app.current ?? "—"} → ${app.available.version}`,
    ]);
  }
  if (S) {
    const m = S.machine, u = S.update ?? {}, r = S.repo;
    if (r.isRepo && r.behind) {
      rows.push([
        "agents-multi",
        `${r.version} → ${t("sc.commits", { n: r.behind })}`,
      ]);
    }
    if (u.cli?.latest && u.cli.latest !== m.cliVersion) {
      rows.push(["Claude Code", `${m.cliVersion ?? "—"} → ${u.cli.latest}`]);
    }
    const desk = desktopNext(S);
    if (desk) rows.push(["Claude Desktop", `${m.desktopVersion ?? "—"} → ${desk}`]);
    else if (m.desktopStaged) {
      rows.push([
        "Claude Desktop",
        `${m.desktopVersion ?? "—"} → ${m.desktopStaged} · ${t("sc.staged")}`,
      ]);
    }
  }
  return (
    <div class="vv">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <span>{k}</span>
          <em>{v}</em>
        </Fragment>
      ))}
    </div>
  );
}

export function UpdateReady() {
  if (!sys.value.pending.length) return null;
  const S = status.value, app = appUpdater();
  const news = app?.available?.notes ? notePoints(app.available.notes) : [];
  // Desktop restarts to take its new version: say which ones are open, and if a session works in one
  const desk = S?.running.desktop.map((d) => d.variant) ?? [];
  const busy = S?.running.cli.filter((c) => c.embedded).length ?? 0;
  return (
    <div class="upd">
      <h4>
        <svg
          width="15"
          height="15"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <path d="M8 13V3M4 7l4-4 4 4" />
        </svg>
        {t(sys.value.upWord)}
      </h4>
      <UpdateRows />
      {news.length > 0 && <ul>{news.map((l) => <li key={l}>{l}</li>)}</ul>}
      <div class="go">
        <UpdateNow cls="bt pri" auto />
      </div>
      {S?.machine.desktopStaged && desk.length > 0 && (
        <div class="note">
          {busy ? t("sc.note.busy", { p: desk.join(", "), n: busy }) : t("sc.note", { p: desk.join(", ") })}
        </div>
      )}
    </div>
  );
}
