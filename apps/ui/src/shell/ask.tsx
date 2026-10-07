// ask.tsx — the field to ask Claude, at the foot of Today, Tasks and Brain. A plain question, a new task
// (in the project on screen, in none, or wherever Claude finds it belongs) or a change to the brain: the
// page on screen sets that through `askContext`. The answer streams in above the field; what Claude
// changed with its tools shows at once, through the topics, not at the next event.

import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { get, ndjson, post, postInit, type Result } from "../api.ts";
import { t, tk } from "../i18n.ts";
import { Spark, type SparkMode } from "../lib/claude.tsx";
import { renderMarkdown } from "../lib/markdown.tsx";
import { toast } from "../lib/ui.tsx";
import { touch } from "../state.ts";

export type AskKind = "ask" | "newtask" | "brain";

/** What the field asks for. `project`: for a new task a folder, "~none" or null (Claude picks); for the
 *  brain a page's path or null (the brain as a whole). `label` is the name the chip shows for it. */
export const ask = signal<{ kind: AskKind; project: string | null; label?: string }>({ kind: "ask", project: null });

export function askContext(kind: AskKind, project: string | null = null, label?: string): void {
  ask.value = { kind, project, label };
}

/** Puts the cursor in the field (the "/" key, the new-task button). */
export const focusAsk = signal(0);

function ctxLabel(): string {
  const { kind, project, label } = ask.value;
  if (kind === "brain") return project ? t("ask.ctx.brain", { p: label ?? project }) : t("ask.ctx.brainAll");
  if (kind !== "newtask") return "";
  if (project === null) return t("tb.new");
  return t("ask.ctx.newtask", { p: label ?? (project === "~none" ? t("tb.noProject") : project.split("/").pop()!) });
}

interface Answer {
  q: string;
  text: string;
  state: SparkMode;
  /** what the status line says while Claude works */
  doing: string;
  error: string | null;
  done: boolean;
  code: string | null;
}

export function AskDock() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [models, setModels] = useState<{ models: string[]; model: string } | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const busy = useRef<AbortController | null>(null);
  const session = useRef<string | null>(null);
  const last = useRef("");

  // the model the requests go to: one choice, shared with the Hey window (kept by the server)
  const loadModel = () => get<{ models: string[]; model: string }>("/api/ask/model").then(setModels, () => setModels(null));
  useEffect(() => void loadModel(), []);

  useEffect(() => {
    if (focusAsk.value) ta.current?.focus();
  }, [focusAsk.value]);

  // "/" anywhere outside a field puts the cursor in the field, as in most chat apps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as Element)?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      ta.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [answer?.text]);

  const autosize = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
    let acc = "", tools = false, code: string | null = null, frame = 0;
    let a: Answer = { q: text, text: "", state: "thinking", doing: t("ask.thinking"), error: null, done: false, code: null };
    setAnswer(a);
    const paint = () => {
      frame = 0;
      setAnswer((a = { ...a, text: acc.replace(/\[\[code:[^\]]*\]\]/g, "") }));
    };
    busy.current = new AbortController();
    try {
      const where = project === "~none" ? { noProject: true } : { project };
      const res = await fetch("/api/ask", postInit({ text, kind, ...where, session: session.current }, busy.current.signal));
      if (!res.ok || !res.body) {
        throw new Error((await res.json().catch(() => ({})) as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await ndjson<{ t: string; d?: string; id?: string; k?: string; text?: string; error?: string; code?: string }>(
        res,
        (o) => {
          if (o.t === "session") session.current = o.id ?? null;
          else if (o.t === "text") {
            acc += o.d ?? "";
            if (a.state !== "writing") setAnswer((a = { ...a, state: "writing" }));
            if (!frame) frame = requestAnimationFrame(paint);
          } else if (o.t === "tool") {
            tools = true;
            setAnswer((a = { ...a, state: "thinking", doing: tk(`ask.tool.${o.k}`) }));
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
    if (tools) touch("tasks");
    // what Claude changed in the brain shows at once
    if (kind === "brain" && tools) touch("brain");
    el.focus();
  };

  const terminal = async (body: Record<string, unknown>) => {
    const r = await post("/api/terminal", body).catch((err: Error): Result => ({ ok: false, message: err.message }));
    if (!r.ok) toast(r.message ?? "", true);
  };

  const pickModel = async (model: string) => {
    const r = await post("/api/ask/model", { model }).catch((err: Error): Result => ({ ok: false, message: err.message }));
    if (!r.ok) {
      toast(r.message ?? "", true);
      void loadModel();
    }
    ta.current?.focus();
  };

  const ctx = ask.value.kind === "ask" ? "" : ctxLabel();
  const ph = ask.value.kind === "newtask" ? "ask.ph.newtask" : ask.value.kind === "brain" ? "ask.ph.brain" : "ask.ph";
  const codeName = answer?.code ? answer.code.replace(/\/+$/, "").split("/").pop() || "~" : "";

  return (
    <div class="ask-dock">
      {answer && (
        <section class="answer" aria-live="polite">
          <div class="answer-q">{answer.q}</div>
          <div class="answer-b md" ref={body}>
            {answer.error ? <p class="err">{answer.error}</p> : renderMarkdown(answer.text)}
          </div>
          <div class="answer-f">
            <span class="answer-s">
              {answer.done ? <span>{t("ask.followup")}</span> : (
                <>
                  <Spark mode={answer.state} />
                  <span class="ask-state">{answer.doing}</span>
                </>
              )}
            </span>
            {answer.done && session.current && (
              <button type="button" class="btn sm" onClick={() => terminal({ resume: session.current })}>{t("ask.terminal")}</button>
            )}
            {answer.done && answer.code && (
              <button type="button" class="btn sm primary" onClick={() => terminal({ cwd: answer.code, ask: last.current })}>
                {t("ask.code", { p: codeName })}
              </button>
            )}
            <button type="button" class="icon-btn" title={t("ask.close")} onClick={close}>
              <svg viewBox="0 0 24 24" class="ico"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </div>
        </section>
      )}
      <form class="composer" onSubmit={submit}>
        <Spark mode={answer && !answer.done ? "thinking" : ""} />
        {ctx && (
          <span class="ask-ctx">
            <span>{ctx}</span>
            <button
              type="button"
              title={t("ask.ctx.clear")}
              onClick={() => {
                askContext("ask");
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
          placeholder={t(ph)}
          onInput={autosize}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              (e.currentTarget.form as HTMLFormElement).requestSubmit();
            }
            if (e.key === "Escape") {
              if (answer) close();
              else e.currentTarget.blur();
            }
          }}
        />
        {models && (
          <select class="ask-model" title={t("ask.model")} value={models.model} onChange={(e) => pickModel(e.currentTarget.value)}>
            {models.models.map((m) => <option key={m} value={m}>{tk(`ask.model.${m}`)}</option>)}
          </select>
        )}
        <button class="send" type="submit" title={t("ask.send")}>
          <svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </form>
    </div>
  );
}
