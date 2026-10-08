// health.tsx — the brain's own check (orphans, broken links, long pages, a stale inbox, pages outside
// the areas), each group a list that opens its page, and one button that hands them all to Claude.

import type { ComponentChildren } from "preact";
import { t } from "../../i18n.ts";
import { renderMarkdown } from "../../lib/markdown.tsx";
import { areaOf, bare, type Brain } from "./model.ts";

export function BrainHealth({ brain, onPage, onOpen, onFix }: {
  brain: Brain;
  onPage: (target: string) => void;
  onOpen: (path: string) => void;
  onFix: () => void;
}) {
  const h = brain.health;
  if (!h) {
    return (
      <div class="bn-health" id="bn-health">
        <p class="sub">{t("brain.away", { e: "/api/brain/health" })}</p>
      </div>
    );
  }

  const page = (path: string, extra?: ComponentChildren) => {
    const p = brain.byPath.get(path);
    return (
      <button
        type="button"
        class="bl"
        key={path + String(extra)}
        onClick={() => onOpen(path)}
      >
        <i class="gdot" style={{ background: `var(--g-${areaOf(p?.area)})` }} />
        <span>{p?.title ?? bare(path)}</span>
        {extra}
      </button>
    );
  };
  const group = (
    key: "orphans" | "broken" | "long" | "inbox" | "outside",
    rows: ComponentChildren[],
  ) =>
    rows.length
      ? (
        <section class="panel hl-g" key={key}>
          <div class="panel-h">
            <h3>{t(`brain.h.${key}`)}</h3>
            <span class="r">{rows.length}</span>
          </div>
          <div class="bl-list">{rows}</div>
        </section>
      )
      : null;
  const groups = [
    group("orphans", h.orphans.map((x) => page(x))),
    group(
      "broken",
      h.broken_links.map((b) => page(b.page, <em class="hl-x">→ {b.link}</em>)),
    ),
    group(
      "long",
      h.too_long.map((x) =>
        page(x.page, <em class="hl-x">{t("brain.h.words", { n: x.words })}</em>)
      ),
    ),
    group(
      "inbox",
      h.inbox_older_than_a_week.map((l, i) => (
        <div class="hl-line" key={i}>
          {renderMarkdown(l.replace(/^- /, ""), onPage)}
        </div>
      )),
    ),
    group("outside", h.outside_the_areas.map((x) => page(x))),
  ].filter(Boolean);

  return (
    <div class="bn-health" id="bn-health">
      {groups.length
        ? (
          <>
            <div class="hl-top">
              <span>
                {t("brain.sum", { p: h.pages, l: brain.edges.length })}
              </span>
              <button type="button" class="btn primary sm" onClick={onFix}>
                {t("brain.h.fix")}
              </button>
            </div>
            {groups}
          </>
        )
        : (
          <div class="status-card ok">
            <i />
            <div>{t("brain.h.ok")}</div>
          </div>
        )}
    </div>
  );
}
