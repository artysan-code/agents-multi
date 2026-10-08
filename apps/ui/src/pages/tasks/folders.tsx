// folders.tsx — the left pane: the projects that have something open, as the owner's folders tree.

import { t } from "../../i18n.ts";
import type { BoardTask } from "./api.ts";
import { Fragment } from "preact";
import { allFolders, board, currentProject, isOpen, NONE, pickProject } from "./model.ts";

function Row({ k, label, n, depth = 0 }: { k: string | null; label: string; n: number; depth?: number }) {
  const on = currentProject() === k;
  return (
    <button
      type="button"
      class={`tf${on ? " on" : ""}`}
      style={{ "--d": depth }}
      title={k ?? undefined}
      onClick={() => pickProject(k)}
    >
      <span>{label}</span>
      {n > 0 && <i>{n}</i>}
    </button>
  );
}

export function Folders() {
  const b = board.value;
  if (!b) return <nav class="pane-b" aria-label="Projects" />;
  const sel = currentProject();
  const open = b.tasks.filter(isOpen);
  const counts = new Map<string, number>(), other = new Map<string, number>();
  let none = 0;
  for (const x of open as BoardTask[]) {
    if (x.folder) {
      const parts = x.folder.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join("/");
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    } else if (x.project) other.set(x.project, (other.get(x.project) ?? 0) + 1);
    else none++;
  }
  const all = allFolders.value;
  const nodes = b.projects.filter((n) => n.depth > 0 && (counts.has(n.path) || (all && n.depth <= 2) || n.path === sel));
  const roots = b.projects.filter((n) => n.depth === 0 && (counts.has(n.path) || all));
  return (
    <nav class="pane-b" aria-label="Projects">
      <Row k={null} label={t("tb.allProjects")} n={open.length} />
      <Row k={NONE} label={t("tb.noProject")} n={none} />
      {roots.map((r) => (
        <Fragment key={r.path}>
          <div class="tf root" style={{ "--d": 0 }}><span>{r.name}</span></div>
          {nodes.filter((n) => n.path.startsWith(r.path + "/")).map((n) => (
            <Row key={n.path} k={n.path} label={n.name} n={counts.get(n.path) ?? 0} depth={n.depth - 1} />
          ))}
        </Fragment>
      ))}
      {other.size > 0 && (
        <>
          <div class="tf root"><span>{t("tb.other")}</span></div>
          {[...other].sort().map(([p, n]) => <Row key={p} k={`~other:${p}`} label={p} n={n} />)}
        </>
      )}
      <button type="button" class="tf-more" onClick={() => allFolders.value = !all}>
        {t(all ? "tb.fewFolders" : "tb.allFolders")}
      </button>
    </nav>
  );
}
