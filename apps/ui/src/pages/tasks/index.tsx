// tasks/index.tsx — the Tasks page. A task lives in a project: the projects are the owner's folders
// (personal/…, work/…), plus the short names a chat used, plus "no project" for simple things. On the left
// the projects that have something open; on the right either all of them at a glance or one project's
// board, and each task's own page (the sheet, a drawer). A new task is explained to Claude in the field at
// the bottom, which writes it down. The data is the same files a chat changes through the tasks MCP
// server, so a "tasks" event redraws what is open.

import { useEffect, useRef } from "preact/hooks";
import { t } from "../../i18n.ts";
import { toastErr } from "../../lib/ui.tsx";
import { useIntent } from "../../router.ts";
import { askContext, focusAsk } from "../../shell/ask.tsx";
import { useTopic } from "../../state.ts";
import { Kanban, Overview } from "./board.tsx";
import { Folders } from "./folders.tsx";
import { openPath } from "./api.ts";
import {
  board,
  currentProject,
  inProject,
  isOpen,
  NONE,
  openCount,
  type OwnerFilter,
  ownerFilter,
  projectLabel,
  projectValue,
  query,
  refreshBoard,
  stepsOf,
  visible,
} from "./model.ts";

export { openTask } from "./sheet.tsx";

const OWNERS: OwnerFilter[] = ["all", "me", "claude", "others"];

function Head() {
  const p = currentProject();
  const xs = (board.value?.tasks ?? []).filter((x) => !p || inProject(x, p))
    .filter(isOpen);
  const s = stepsOf(xs);
  const isFolder = !!p && !p.startsWith("~");
  return (
    <div class="tk-title">
      <h2>{p ? projectLabel(p) : t("tb.allProjects")}</h2>
      <div class="crumb">
        {isFolder && (
          <>
            <span>~/{p}</span>
            <button type="button" onClick={() => openPath(`~/${p}`)}>
              {t("ts.openFolder")}
            </button>
          </>
        )}
        <span>
          {openCount(xs.length)}
          {s.n > 0 && `, ${t("tb.steps", { d: s.d, n: s.n })}`}
        </span>
      </div>
    </div>
  );
}

export function Tasks() {
  const timer = useRef<number | undefined>(undefined);
  useTopic(() => refreshBoard().catch(toastErr), ["tasks"]);

  const p = currentProject();
  const newTask = () => {
    askContext("newtask", p === NONE ? NONE : projectValue(p));
    focusAsk.value++;
  };
  // on this page the field writes new tasks, in the project on screen
  useEffect(() => {
    if (board.value) askContext("newtask", p === NONE ? NONE : projectValue(p));
  }, [p, board.value]);
  useIntent("tasks.new", newTask);

  const xs = visible();
  return (
    <div class="tk-frame">
      <section class="pane tk-projects">
        <div class="pane-h">
          <h3>{t("tb.projects")}</h3>
        </div>
        <Folders />
      </section>
      <section class="pane tk-main">
        <header class="tk-head">
          <Head />
          <div class="tk-tools">
            <input
              class="search"
              type="search"
              placeholder={t("tb.search")}
              autocomplete="off"
              defaultValue={query.value}
              onInput={(e) => {
                const v = e.currentTarget.value.trim();
                clearTimeout(timer.current);
                timer.current = setTimeout(() => query.value = v, 120);
              }}
            />
            <div class="seg" role="group">
              {OWNERS.map((o) => (
                <button
                  key={o}
                  type="button"
                  aria-pressed={ownerFilter.value === o}
                  onClick={() => ownerFilter.value = o}
                >
                  {t(`tb.owner.${o}`)}
                </button>
              ))}
            </div>
            <button type="button" class="btn primary" onClick={newTask}>
              {t("tb.new")}
            </button>
          </div>
        </header>
        <div class="tk-body">
          {board.value && (p ? <Kanban xs={xs} /> : <Overview xs={xs} />)}
        </div>
      </section>
    </div>
  );
}
