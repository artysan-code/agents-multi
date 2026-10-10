// ask.tsx — the bar to ask Claude, at the top of Today, Tasks and Brain. Nothing to choose: Claude
// works out from what is written whether it is a question, something to do (a task, with a time when
// one fits) or something to remember (the brain), and acts. The page on screen may set a context
// through `askContext` (the project of a new task, the brain page in view). The answer streams into a
// panel over the page (Esc closes it), with each change Claude made as a chip, as a tool call; what it
// changed shows at once, through the topics, not at the next event.

import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ndjson, type Result } from "../api.ts";
import { t, tk } from "../i18n.ts";
import { Spark, type SparkMode } from "../lib/claude.tsx";
import { renderMarkdown } from "../lib/markdown.tsx";
import { drawerOpen, toast } from "../lib/ui.tsx";
import { ModelPicker, useAskModel } from "../lib/model-picker.tsx";
import { paletteOpen } from "./palette.tsx";
import { touch } from "../state.ts";
import "./ask.css";

export type AskKind = "ask" | "newtask" | "brain";

/** What the field asks for. `project`: for a new task a folder, "~none" or null (Claude picks); for the
 *  brain a page's path or null (the brain as a whole). `label` is the name the chip shows for it. */
export const ask = signal<{ kind: AskKind; project: string | null; label?: string }>({ kind: "ask", project: null });

export function askContext(kind: AskKind, project: string | null = null, label?: string): void {
  ask.value = { kind, project, label };
}

/** Puts the cursor in the field (the "/" key, the new-task button). */
export const focusAsk = signal(0);

const queued = signal<string | null>(null);

/** Sends `text` from the field as if typed there, in the context set now ("Fix with Claude"). */
export function askNow(text: string): void {
  queued.value = text;
}

function ctxLabel(): string {
  const { kind, project, label } = ask.value;
  if (kind === "brain") return project ? t("ask.ctx.brain", { p: label ?? project }) : t("ask.ctx.brainAll");
  if (kind !== "newtask") return "";
  if (project === null) return t("tb.new");
  return t("ask.ctx.newtask", { p: label ?? (project === "~none" ? t("tb.noProject") : project.split("/").pop()!) });
}

/** A change Claude made with a tool: which tool, and what it was on. */
interface Act {
  k: string;
  n: string;
  d?: string;
}

interface Answer {
  q: string;
  /** the changes made, in order */
  acts: Act[];
  text: string;
  state: SparkMode;
  /** what the status line says while Claude works */
  doing: string;
  error: string | null;
  done: boolean;
  code: string | null;
}

export function AskBar() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const { state: models, pick } = useAskModel((m) => toast(m, true));
  const ta = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const busy = useRef<AbortController | null>(null);
  const session = useRef<string | null>(null);
  const last = useRef("");

  useEffect(() => {
    if (focusAsk.value) ta.current?.focus();
  }, [focusAsk.value]);

  useEffect(() => {
    const text = queued.value;
    if (text === null || !ta.current?.form) return;
    queued.value = null;
    ta.current.value = text;
    ta.current.form.requestSubmit();
  }, [queued.value]);

  // "/" anywhere outside a field puts the cursor in the bar, as in most chat apps; Esc closes the answer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && answer && !drawerOpen() && !paletteOpen.value) {
        close();
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as Element)?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      ta.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [answer]);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [answer?.text]);

  const autosize = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const close = () => {
    busy.current?.abort();
    busy.current = null;
    session.current = null;
    setAnswer(null);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const el = ta.current!;
    const text = el.value.trim();
    if (!text || busy.current) return;
    el.value = "";
    autosize();
    last.current = text;
    const { kind, project } = ask.value;
    let acc = "", code: string | null = null, frame = 0;
    const used = new Set<string>();
    let a: Answer = {
      q: text,
      acts: [],
      text: "",
      state: "thinking",
      doing: t("ask.thinking"),
      error: null,
      done: false,
      code: null,
    };
    setAnswer(a);
    const paint = () => {
      frame = 0;
      setAnswer((a = { ...a, text: acc.replace(/\[\[code:[^\]]*\]\]/g, "") }));
    };
    busy.current = new AbortController();
    try {
      const where = project === "~none" ? { noProject: true } : { project };
      const res = await api.ask({ text, kind, ...where, session: session.current }, busy.current.signal);
      if (!res.ok || !res.body) {
        throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await ndjson<
        { t: string; d?: string; id?: string; k?: string; n?: string; text?: string; error?: string; code?: string }
      >(
        res,
        (o) => {
          if (o.t === "session") session.current = o.id ?? null;
          else if (o.t === "text") {
            acc += o.d ?? "";
            if (a.state !== "writing") setAnswer((a = { ...a, state: "writing" }));
            if (!frame) frame = requestAnimationFrame(paint);
          } else if (o.t === "tool") {
            used.add(o.k ?? "");
            const acts = o.d ? [...a.acts, { k: o.k ?? "", n: o.n ?? "", d: o.d }] : a.acts;
            setAnswer((a = { ...a, acts, state: "thinking", doing: tk(`ask.tool.${o.k}`) }));
          } else if (o.t === "done") {
            if (o.error) setAnswer((a = { ...a, error: t("ask.failed", { e: o.error }) }));
            else {
              acc = o.text ?? acc;
              paint();
            }
            code = o.code ?? null;
          }
        },
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setAnswer((a = { ...a, error: t("ask.failed", { e: (err as Error).message }) }));
    }
    if (!busy.current) return; // closed while it answered
    busy.current = null;
    setAnswer((a = { ...a, state: "", done: true, code }));
    // a new task is one thing: the next request is a plain one again
    if (kind === "newtask") askContext("ask");
    if (used.has("tasks")) touch("tasks");
    // what Claude changed in the brain shows at once
    if (used.has("brain")) touch("brain");
    el.focus();
  };

  const terminal = async (body: Record<string, unknown>) => {
    const r = await api.terminal(body).catch((err: Error): Result => ({ ok: false, message: err.message }));
    if (!r.ok) toast(r.message ?? "", true);
  };

  const kind = ask.value.kind;
  const ctx = kind !== "ask" && ask.value.project !== null ? ctxLabel() : "";
  const ph = kind === "newtask" ? "ask.ph.newtask" : kind === "brain" ? "ask.ph.brain" : "ask.ph";
  const codeName = answer?.code ? answer.code.replace(/\/+$/, "").split("/").pop() || "~" : "";
  const working = !!answer && !answer.done;

  return (
    <div class="ab-wrap">
      <form class="ab" onSubmit={submit}>
        <Spark mode={working ? "thinking" : ""} class="spark ab-spk" />
        {ctx && (
          <span class="ab-ctx">
            <span>{ctx}</span>
            <button
              type="button"
              title={t("ask.ctx.clear")}
              onClick={() => {
                askContext(kind, null);
                ta.current?.focus();
              }}
            >
              ×
            </button>
          </span>
        )}
        <textarea
          ref={ta}
          name="text"
          rows={1}
          autocomplete="off"
          aria-label={t("ask.label")}
          placeholder={t(ph)}
          onInput={autosize}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }
            if (e.key === "Escape" && !answer) e.currentTarget.blur();
          }}
        />
        {models && <ModelPicker state={models} onPick={(m) => void pick(m)} onDone={() => ta.current?.focus()} />}
        <button class="ab-send" type="submit" title={t("ask.send")} aria-label={t("ask.send")}>
          <svg viewBox="0 0 20 20"><path d="M10 16V4M5 9l5-5 5 5" /></svg>
        </button>
      </form>
      {answer && (
        <section class="ab-sheet" role="dialog" aria-label={t("ask.sheet")} aria-live="polite">
          <div class="ab-q">
            <Spark mode={working ? answer.state : ""} />
            <span>{answer.q}</span>
          </div>
          {answer.acts.length > 0 && (
            <ul class="ab-acts">
              {answer.acts.map((x, i) => (
                <li key={i} class={`ab-act ${x.k}`}>
                  <span class="ab-act-n">{tk(`ask.act.${x.n}`)}</span>
                  <span class="ab-act-d">{x.d}</span>
                </li>
              ))}
            </ul>
          )}
          <div class="ab-a md" ref={body}>
            {answer.error ? <p class="err">{answer.error}</p> : renderMarkdown(answer.text)}
          </div>
          <div class="ab-f">
            <span class="ab-s" role="status">
              {answer.done ? t("ask.followup") : answer.doing}
            </span>
            {answer.done && session.current && (
              <button type="button" class="bt sm ghost" onClick={() => terminal({ resume: session.current })}>{t("ask.terminal")}</button>
            )}
            {answer.done && answer.code && (
              <button type="button" class="bt sm pri" onClick={() => terminal({ cwd: answer.code, ask: last.current })}>
                {t("ask.code", { p: codeName })}
              </button>
            )}
            <span class="ab-m">
              {models ? `${tk(`ask.model.${models.model}`)} · ` : ""}
              <kbd class="k2">Esc</kbd> {t("ask.esc")}
            </span>
            <button type="button" class="ib ab-x" title={t("ask.close")} aria-label={t("ask.close")} onClick={close}>
              <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
