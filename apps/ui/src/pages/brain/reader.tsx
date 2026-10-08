// reader.tsx — a page on screen: the crumb, who wrote and when, the text (or an older version, or what
// changed since), and beside it the links both ways and every version.

import { useEffect, useRef } from "preact/hooks";
import { t, tk } from "../../i18n.ts";
import { ago } from "../../lib/format.ts";
import { Markdown } from "../../lib/markdown.tsx";
import type { PageReply } from "./api.ts";
import { areaOf, bare, type Brain, groupLabel, lineDiff, when, who, withoutTitle } from "./model.ts";

export interface OldVersion {
  rev: number;
  body: string;
  at: string;
  by: string;
  diff: boolean;
}

/** The old version against the current one, changed lines with three lines of context around. */
function Diff({ old, cur }: { old: string; cur: string }) {
  const d = lineDiff(old, cur);
  if (!d.some(([op]) => op !== " ")) return <p class="sub">{t("brain.ver.same")}</p>;
  const near = d.map((_, k) => d.slice(Math.max(0, k - 3), k + 4).some(([op]) => op !== " "));
  let gap = false;
  const rows = d.map(([op, line], k) => {
    if (!near[k]) {
      const g = gap ? null : <div class="df-gap" key={k}>⋯</div>;
      gap = true;
      return g;
    }
    gap = false;
    return (
      <div key={k} class={`df-l${op === "+" ? " add" : op === "-" ? " del" : ""}`}>
        <i>{op === " " ? "" : op}</i>
        <span>{line || " "}</span>
      </div>
    );
  });
  return (
    <>
      <p class="sub bn-dlegend">{t("brain.ver.legend")}</p>
      <div class="df">{rows}</div>
    </>
  );
}

export function Reader({ brain, sel, page, ver, error, onPage, onVerView, onVerClose }: {
  brain: Brain;
  sel: string | null;
  page: PageReply | null;
  ver: OldVersion | null;
  error: string | null;
  onPage: (target: string) => void;
  onVerView: (diff: boolean) => void;
  onVerClose: () => void;
}) {
  const el = useRef<HTMLElement>(null);
  const shownPath = page?.path;
  useEffect(() => {
    if (el.current) el.current.scrollTop = 0;
  }, [shownPath]);

  const known = sel ? brain.byPath.get(sel) : null;
  if (error) return <article class="panel bn-page" id="bn-page" ref={el}><div class="bn-body"><p class="sub">{error}</p></div></article>;
  if (!page || !known || page.path !== sel) {
    return (
      <article class="panel bn-page" id="bn-page" ref={el}>
        {known && <div class="bn-body"><p class="sub">{t("brain.loading")}</p></div>}
      </article>
    );
  }
  const g = areaOf(page.area);
  return (
    <article class="panel bn-page" id="bn-page" ref={el}>
      <div class="bn-body">
        <div class="bn-crumb">
          {bare(page.path).split("/").map((x, i) => (
            <>
              {i > 0 && <>{" "}<span>/</span>{" "}</>}
              {x}
            </>
          ))}
        </div>
        <h1 class="bn-title">{page.title}</h1>
        <div class="bn-meta">
          <i class="gdot" style={{ background: `var(--g-${g})` }} />
          {g !== "other" ? groupLabel(g) : page.area}
          <span title={when(page.updated)}>{t("brain.updatedBy", { d: ago(page.updated), w: who(page.by) })}</span>
          <span class="chip">{t("brain.rev", { n: page.rev })}</span>
        </div>
        {ver && (
          <div class="bn-ver">
            <span>{t("brain.ver.title", { n: ver.rev, d: when(ver.at), w: who(ver.by) })}</span>
            <span class="seg">
              <button type="button" aria-pressed={!ver.diff} onClick={() => onVerView(false)}>{t("brain.ver.read")}</button>
              <button type="button" aria-pressed={ver.diff} onClick={() => onVerView(true)}>{t("brain.ver.diff")}</button>
            </span>
            <button type="button" class="btn sm" onClick={onVerClose}>{t("brain.ver.back")}</button>
          </div>
        )}
        {ver?.diff
          ? <Diff old={ver.body} cur={page.body} />
          : <Markdown src={withoutTitle(ver ? ver.body : page.body)} onPage={onPage} class="md bn-md" />}
      </div>
    </article>
  );
}

/** Linked from, links to, and the versions: the panel under the local graph. */
export function Links({ brain, sel, page, ver, onOpen, onVersion }: {
  brain: Brain;
  sel: string | null;
  page: PageReply | null;
  ver: OldVersion | null;
  onOpen: (path: string) => void;
  onVersion: (rev: number) => void;
}) {
  if (!page || page.path !== sel) return <section class="panel" id="bn-links" />;
  const row = (path: string, label: string) => (
    <button type="button" class="bl" key={path} data-page={path} onClick={() => onOpen(path)}>
      <i class="gdot" style={{ background: `var(--g-${areaOf(brain.byPath.get(path)?.area)})` }} />
      <span>{label}</span>
    </button>
  );
  const back = page.links.back.map((x) => brain.byPath.get(x)).filter((p) => !!p).sort((a, b) => a!.title.localeCompare(b!.title));
  const out = page.links.out;
  const none = <span class="sub">{t("brain.none")}</span>;
  return (
    <section class="panel" id="bn-links">
      <div class="panel-h"><h3>{t("brain.backlinks")}</h3><span class="r">{back.length}</span></div>
      <div class="bl-list">{back.length ? back.map((p) => row(p!.path, p!.title)) : none}</div>
      <div class="panel-h"><h3>{t("brain.outlinks")}</h3><span class="r">{out.length}</span></div>
      <div class="bl-list">
        {out.length
          ? out.map((l) =>
            l.path
              ? row(l.path, brain.byPath.get(l.path)?.title ?? bare(l.path))
              : (
                <span class="bl broken" key={l.target} title={t("brain.broken")}>
                  <i class="gdot" />
                  <span>{l.target}</span>
                </span>
              )
          )
          : none}
      </div>
      <div class="panel-h"><h3>{t("brain.versions")}</h3><span class="r">{page.versions.length}</span></div>
      <div class="bl-list">
        {page.versions.map((x) => (
          <button
            type="button"
            key={x.rev}
            class={`bv${ver?.rev === x.rev ? " on" : ""}${x.rev === page.rev ? " cur" : ""}`}
            data-rev={x.rev}
            onClick={() => onVersion(x.rev)}
          >
            <b>{String(x.rev)}</b>
            <span>{ago(x.at)} · {who(x.by)}</span>
            <em>{tk(`brain.op.${x.op}`)}</em>
          </button>
        ))}
      </div>
    </section>
  );
}
