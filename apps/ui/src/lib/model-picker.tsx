// model-picker.tsx — the model Claude answers with, chosen from a popover in the app's style: a button
// with the model's dot and name, and a list with a hint and an effort gauge for each model, the default
// marked. Alt M opens it; ↑ ↓, Enter, 1–3 and Esc work inside. The choice is one, kept by the server
// (/api/ask/model) and shared by the console's ask bar and the Hey window. With `host` the list is drawn
// there, in the page's flow, instead of over the page: the Hey window is as tall as its page, and a
// list over the page would fall outside it.

import { useEffect, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { get, post, type Result } from "../api.ts";
import { type Key, t, tk } from "../i18n.ts";
import "./model-picker.css";

/** GET /api/ask/model. `efforts` and `default` came later: an older console sends only the names. */
interface ModelState {
  model: string;
  models: string[];
  efforts?: Record<string, string>;
  default?: string;
}

const COLOR: Record<string, string> = { haiku: "green", sonnet: "blue", opus: "violet" };
const TICKS: Record<string, number> = { low: 1, medium: 2, high: 3 };
const color = (m: string) => (COLOR[m] ? `var(--c-${COLOR[m]})` : "var(--faint)");

/** The server's model and a way to change it; a refused change reloads what the server keeps. */
export function useAskModel(onError: (msg: string) => void): { state: ModelState | null; pick: (m: string) => Promise<void> } {
  const [state, setState] = useState<ModelState | null>(null);
  const load = () => get<ModelState>("/api/ask/model").then(setState, () => setState(null));
  useEffect(() => void load(), []);
  const pick = async (model: string) => {
    if (!state || model === state.model) return;
    setState({ ...state, model });
    const r = await post("/api/ask/model", { model }).catch((e: Error): Result => ({ ok: false, message: e.message }));
    if (!r.ok) {
      onError(r.message ?? "");
      void load();
    }
  };
  return { state, pick };
}

function Effort({ level, k }: { level?: string; k: string }) {
  const n = level ? TICKS[level] ?? 0 : 0;
  if (!n) return null;
  return (
    <span class="mpk-ef" style={{ "--k": k }} title={tk(`mp.effort.${level}`)} aria-label={tk(`mp.effort.${level}`)}>
      {[1, 2, 3].map((i) => <i key={i} class={i <= n ? "on" : ""} />)}
    </span>
  );
}

export function ModelPicker({ state, onPick, onDone, host, shared = "mp.shared" }: {
  state: ModelState;
  onPick: (model: string) => void;
  /** after a choice or Esc: where the focus goes back (the field) */
  onDone?: () => void;
  /** where the list goes, in the page's flow; without it the list opens over the page */
  host?: HTMLElement | null;
  /** the footer's note on where else the choice applies */
  shared?: Key;
}) {
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const { models, model } = state;

  const show = (o: boolean) => {
    setOpen(o);
    if (o) setHl(Math.max(0, models.indexOf(model)));
  };
  const choose = (i: number) => {
    const m = models[i];
    if (!m) return;
    show(false);
    onPick(m);
    onDone?.();
  };

  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  // Alt M from anywhere on the page; a click elsewhere closes the list
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyM") {
        e.preventDefault();
        show(true);
      }
    };
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!root.current?.contains(n) && !list.current?.contains(n)) setOpen(false);
    };
    addEventListener("keydown", onKey);
    addEventListener("mousedown", onDown);
    return () => {
      removeEventListener("keydown", onKey);
      removeEventListener("mousedown", onDown);
    };
  }, [models, model]);

  const onKey = (e: KeyboardEvent) => {
    const n = models.length;
    if (e.key === "ArrowDown") setHl((hl + 1) % n);
    else if (e.key === "ArrowUp") setHl((hl - 1 + n) % n);
    else if (e.key === "Enter" || e.key === " ") choose(hl);
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) choose(Number(e.key) - 1);
    else if (e.key === "Escape" || e.key === "Tab") {
      show(false);
      if (e.key === "Escape") trigger.current?.focus();
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const def = state.default;
  const pop = open && (
    <div class={`mpk-pop${host ? " flow" : ""}`} role="listbox" aria-label={t("mp.title")} tabindex={-1} ref={list} onKeyDown={onKey}>
      <h6>{t("mp.title")}</h6>
      {models.map((m, i) => (
        <button
          type="button"
          key={m}
          role="option"
          aria-selected={m === model}
          class={`mpk-o${i === hl ? " hl" : ""}`}
          style={{ "--k": color(m) }}
          onMouseEnter={() => setHl(i)}
          onClick={() => choose(i)}
        >
          <i class="mpk-dot" />
          <b>
            {tk(`ask.model.${m}`)}
            {m === def && <em>{t("mp.default")}</em>}
            <Effort level={state.efforts?.[m]} k={color(m)} />
          </b>
          <span class="mpk-k">
            {m === model && (
              <svg viewBox="0 0 14 14">
                <path d="M3 7.5l2.6 2.5L11 4.5" />
              </svg>
            )}
            {i < 9 && <kbd class="k2">{i + 1}</kbd>}
          </span>
          <small>{tk(`ask.model.${m}.hint`)}</small>
        </button>
      ))}
      <div class="mpk-ft">
        <kbd class="k2">↑</kbd>
        <kbd class="k2">↓</kbd> {t("mp.choose")} · <kbd class="k2">↵</kbd> {t("mp.confirm")} · {t(shared)}
      </div>
    </div>
  );
  return (
    <div class="mpk" ref={root}>
      <button
        type="button"
        ref={trigger}
        class="mpk-t"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={t("mp.trigger")}
        style={{ "--k": color(model) }}
        onClick={() => show(!open)}
      >
        <i class="mpk-dot" />
        <span>{tk(`ask.model.${model}`)}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6">
          <path d="M2 4l3 3 3-3" />
        </svg>
      </button>
      {pop && (host ? createPortal(pop, host) : pop)}
    </div>
  );
}
