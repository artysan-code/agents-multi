// index.tsx — «Hey Claude», the quick entry (what apps/tray/hey.py did): one field. What is typed goes to
// the console's /api/ask and streams back under the field; what is typed next continues the same
// conversation. After an answer, "continue in the terminal" opens the conversation in Claude Code, and
// when Claude says the request is work inside a project's files ([[code:PATH]]), one button opens
// Claude Code in that folder with the request. Esc closes, stopping a running answer.
//
// The desktop app shows it at /#hey in a small frameless window of its own (hey.rs), without the
// console's frame. The page tells that window its height and whether an answer is on screen (it then
// stays open when the focus leaves it), and asks it to close, through its title (lib/window.ts).

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t, tk } from "../../i18n.ts";
import { Spark, type SparkMode } from "../../lib/claude.tsx";
import { renderMarkdown } from "../../lib/markdown.tsx";
import { ModelPicker, useAskModel } from "../../lib/model-picker.tsx";
import { closeWindow, sizeWindow } from "../../lib/window.ts";
import { machineLang } from "../../state.ts";
import { heyApi } from "./api.ts";
import "./hey.css";

interface Answer {
  q: string;
  text: string;
  state: SparkMode;
  /** what the status line says while Claude works */
  doing: string;
  error: string | null;
  done: boolean;
  /** the folder Claude named for work inside a project's files */
  code: string | null;
}

const CODE = /\[\[code:[^\]]*\]\]/g;
const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "~";
// wikilinks have no brain page to open here: they read as text
const noPage = () => {};

export function Hey() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const { state: models, pick } = useAskModel((m) => setNote(m));
  // the model list opens here, in the page's flow, so the window grows to show it
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const main = useRef<HTMLElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const busy = useRef<AbortController | null>(null);
  const session = useRef<string | null>(null);
  const shown = useRef(false);
  shown.current = answer !== null;

  useEffect(() => {
    heyApi.status().then((s) => {
      machineLang.value = s.language;
    }, () => {/* the browser's language, then */});
    field.current?.focus();
  }, []);

  // the window fits the page: after every render, and when the layout moves on its own (fonts, wrapping)
  const report = () => {
    if (main.current) sizeWindow(main.current.offsetHeight, shown.current);
  };
  useLayoutEffect(report);
  useEffect(() => {
    const ro = new ResizeObserver(report);
    if (main.current) ro.observe(main.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [answer?.text]);

  const close = () => {
    busy.current?.abort();
    busy.current = null;
    closeWindow();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      close();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const submit = async (e: Event) => {
    e.preventDefault();
    const el = field.current!;
    const text = el.value.trim();
    if (!text || busy.current) return;
    el.value = "";
    setNote(null);
    let acc = "", frame = 0;
    let a: Answer = {
      q: text,
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
      setAnswer(a = { ...a, text: acc.replace(CODE, "") });
    };
    const ctl = busy.current = new AbortController();
    try {
      await heyApi.ask(text, session.current, ctl.signal, (o) => {
        if (o.t === "session") session.current = o.id;
        else if (o.t === "text") {
          acc += o.d;
          if (a.state !== "writing") setAnswer(a = { ...a, state: "writing" });
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (o.t === "tool") {
          setAnswer(
            a = { ...a, state: "thinking", doing: tk(`ask.tool.${o.k}`) },
          );
        } else if (o.t === "done") {
          if (o.error) {
            setAnswer(a = { ...a, error: t("ask.failed", { e: o.error }) });
          } else {
            acc = o.text;
            paint();
          }
          a = { ...a, code: o.code };
        }
      });
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setAnswer(
          a = { ...a, error: t("ask.failed", { e: (err as Error).message }) },
        );
      }
    }
    if (busy.current !== ctl) return; // closed while it answered
    busy.current = null;
    if (frame) cancelAnimationFrame(frame);
    setAnswer({
      ...a,
      text: acc.replace(CODE, "").trim(),
      state: "",
      done: true,
    });
    el.focus();
  };

  const handOver = async (
    body: { resume: string } | { cwd: string; ask: string },
  ) => {
    setNote(null);
    const r = await heyApi.terminal(body).catch((err: Error) => ({
      ok: false,
      message: err.message,
    }));
    if (r.ok) closeWindow();
    else setNote(r.message ?? "");
  };

  return (
    <main class="hey" ref={main}>
      <form class="hey-row" onSubmit={submit}>
        <Spark mode={answer && !answer.done ? "thinking" : ""} />
        <input
          ref={field}
          name="text"
          autocomplete="off"
          spellcheck={false}
          aria-label={t("hey.title")}
          placeholder={t(answer ? "hey.ph.more" : "hey.ph")}
        />
        {models && (
          <ModelPicker
            state={models}
            host={host}
            shared="mp.shared.hey"
            onPick={(m) => void pick(m)}
            onDone={() => field.current?.focus()}
          />
        )}
        <kbd>Esc</kbd>
      </form>
      <div ref={setHost} />
      {answer && (
        <section class="hey-body" aria-live="polite">
          <div class="hey-q">{answer.q}</div>
          <div class="hey-a md" ref={body}>
            {answer.error
              ? <p class="err">{answer.error}</p>
              : renderMarkdown(answer.text, noPage)}
          </div>
          <div class="hey-f">
            <span class="hey-s" role="status">
              {note
                ? <span class="err">{note}</span>
                : answer.done
                ? <span>{t("ask.followup")}</span>
                : (
                  <>
                    <Spark mode={answer.state} />
                    <span>{answer.doing}</span>
                  </>
                )}
            </span>
            {answer.done && session.current && (
              <button
                type="button"
                class="btn sm"
                onClick={() => handOver({ resume: session.current! })}
              >
                {t("ask.terminal")}
              </button>
            )}
            {answer.done && answer.code && (
              <button
                type="button"
                class="btn sm primary"
                onClick={() => handOver({ cwd: answer.code!, ask: answer.q })}
              >
                {t("ask.code", { p: folderName(answer.code) })}
              </button>
            )}
          </div>
        </section>
      )}
      {!answer && note && <p class="hey-s err" role="status">{note}</p>}
    </main>
  );
}
