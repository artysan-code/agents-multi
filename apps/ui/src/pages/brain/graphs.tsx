// graphs.tsx — the two graphs: the page's neighbourhood beside the reader, and the whole brain on its
// own screen. The canvas is drawn imperatively by graph.ts; this owns its element and its lifetime.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ago } from "../../lib/format.ts";
import { t } from "../../i18n.ts";
import { forceGraph, type GNode, type Graph } from "./graph.ts";
import { areaOf, AREAS, bare, type Brain, groupLabel, who } from "./model.ts";

const nodeOf = (b: Brain, path: string): GNode | null => {
  const p = b.byPath.get(path);
  return p ? { id: p.path, title: p.title, group: areaOf(p.area) } : null;
};

/** The page and the pages it links to or is linked from (two steps when asked), live. */
export function LocalGraph({ brain, sel, depth2, onSelect }: {
  brain: Brain;
  sel: string;
  depth2: boolean;
  onSelect: (path: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const graph = useRef<Graph | null>(null);
  const pick = useRef(onSelect);
  pick.current = onSelect;
  const sel_ = useRef(sel);
  sel_.current = sel;

  useEffect(() => {
    graph.current = forceGraph(canvas.current!, {
      onClick: (id) => id && id !== sel_.current && pick.current(id),
      onOpen: (id) => pick.current(id),
      charge: 180,
      distance: 55,
      labelRoom: 110,
      cluster: .02,
    });
    return () => graph.current?.destroy();
  }, []);

  useEffect(() => {
    const g = graph.current!;
    const ids = new Set([sel]);
    const grow = () => {
      for (const id of [...ids]) {
        for (const x of brain.out.get(id) ?? []) ids.add(x);
        for (const x of brain.in.get(id) ?? []) ids.add(x);
      }
    };
    grow();
    if (depth2) grow();
    const nodes = [...ids].map((id) => nodeOf(brain, id)).filter((
      n,
    ): n is GNode => !!n);
    g.setData(nodes, brain.edges.filter(([a, b]) => ids.has(a) && ids.has(b)));
    g.select(sel);
    g.resize();
  }, [brain, sel, depth2]);

  return (
    <canvas
      ref={canvas}
      id="bn-local"
      class="bn-local"
      role="img"
      title={t("brain.graph")}
    />
  );
}

/** The whole graph: a legend that toggles the areas, fit, a card for the picked page, the help. */
export function GlobalGraph({ brain, sel, match, onPick, onRead }: {
  brain: Brain;
  sel: string | null;
  match: Set<string> | null;
  /** a page picked on the graph (a click): it becomes the page the reader will open */
  onPick: (path: string) => void;
  onRead: (path: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const graph = useRef<Graph | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [card, setCard] = useState<string | null>(sel);
  const cb = useRef({ onPick, onRead });
  cb.current = { onPick, onRead };

  useEffect(() => {
    graph.current = forceGraph(canvas.current!, {
      charge: 420,
      distance: 80,
      onClick: (id) => {
        if (id) cb.current.onPick(id);
        setCard(id);
        graph.current?.select(id);
      },
      onOpen: (id) => cb.current.onRead(id),
    });
    return () => graph.current?.destroy();
  }, []);

  const shown = useMemo(
    () => brain.pages.filter((p) => !off.has(areaOf(p.area))),
    [brain, off],
  );
  const visible = useMemo(() => new Set(shown.map((p) => p.path)), [shown]);

  useEffect(() => {
    const g = graph.current!;
    g.setData(
      shown.map((p) => nodeOf(brain, p.path)!),
      brain.edges.filter(([a, b]) => visible.has(a) && visible.has(b)),
    );
    g.resize();
  }, [brain, shown]);
  useEffect(() => graph.current?.setMatch(match), [match, brain, shown]);
  useEffect(
    () => graph.current?.select(card && visible.has(card) ? card : null),
    [card, brain, shown],
  );

  const present = new Set(brain.pages.map((p) => areaOf(p.area)));
  const flip = (g: string) => {
    const next = new Set(off);
    if (!next.delete(g)) next.add(g);
    setOff(next);
  };
  const p = card && visible.has(card) ? brain.byPath.get(card) : null;

  return (
    <div class="bn-graph panel" id="bn-graph">
      <div class="bn-gtools">
        <div class="bn-legend" id="bn-legend">
          {[...AREAS, "other"].filter((g) => present.has(g)).map((g) => (
            <button
              type="button"
              key={g}
              class={`lg${off.has(g) ? " off" : ""}`}
              onClick={() => flip(g)}
            >
              <i style={{ background: `var(--g-${g})` }} />
              {groupLabel(g)}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="btn sm"
          onClick={() => graph.current?.refit()}
        >
          {t("brain.fit")}
        </button>
      </div>
      <canvas
        ref={canvas}
        id="bn-canvas"
        class="bn-canvas"
        role="img"
        title={t("brain.graph")}
      />
      {p && (
        <div class="bn-card" id="bn-card">
          <div class="sub">{bare(p.path)}</div>
          <b>{p.title}</b>
          <div class="sub">
            {t("brain.updatedBy", { d: ago(p.updated), w: who(p.by) })}
          </div>
          <div class="sub">
            {t("brain.linkCount", {
              i: brain.in.get(p.path)?.size ?? 0,
              o: brain.out.get(p.path)?.size ?? 0,
            })}
          </div>
          <button
            type="button"
            class="btn primary sm"
            onClick={() => onRead(p.path)}
          >
            {t("brain.read")}
          </button>
        </div>
      )}
      <p class="bn-help sub">{t("brain.help")}</p>
    </div>
  );
}
