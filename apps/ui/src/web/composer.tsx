// composer.tsx — the box a message is written in: text, dictation (the browser's speech recognition, live words in
// the box), and a voice note (hold the mic and let go to send, slide away to cancel; or tap it for a recording that
// stays open with a Cancel and a Send). The voice note is recorded here and sent as audio; a machine that can
// transcribe turns it into words (ADR 0014, second round).

import type { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { sendsOnEnter } from "./lib.ts";
import { LANGUAGE, t } from "./t.ts";
import { type Dictation, dictation, Recorder, type Take } from "./voice.ts";
import { clock, joinDictation, MAX_BYTES, pushLevel, slidCancel, speechLang } from "./voice-core.ts";
import { Icon } from "./ui.tsx";

interface Rec {
  /** `hold`: the finger is on the mic, letting go sends; `locked`: it stays open for Cancel and Send */
  mode: "hold" | "locked";
  seconds: number;
  cancelling: boolean;
}

interface Props {
  text: string;
  setText: (s: string) => void;
  field: RefObject<HTMLTextAreaElement | null>;
  busy: boolean;
  /** the machine this goes to, shown on the chip */
  where: string;
  onMachine: () => void;
  onSend: () => void;
  onVoice: (take: Take) => Promise<boolean>;
}

const micError = (e: unknown) => {
  const n = (e as Error).name;
  return n === "NotAllowedError" || n === "SecurityError" ? t("voice.blocked") : n === "NotFoundError" ? t("voice.noMic") : `${n}: ${(e as Error).message}`;
};

function Meter({ levels }: { levels: number[] }) {
  const bars = Array.from({ length: 28 }, (_, i) => levels[levels.length - 28 + i] ?? 0);
  return (
    <span class="meter" aria-hidden="true">
      {bars.map((l, i) => <i key={i} style={{ height: `${12 + l * 88}%` }} />)}
    </span>
  );
}

export function Composer({ text, setText, field, busy, where, onMachine, onSend, onVoice }: Props) {
  const [rec, setRecState] = useState<Rec | null>(null);
  const recRef = useRef<Rec | null>(null);
  const [levels, setLevels] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [listening, setListening] = useState(false);
  const taker = useRef<Recorder | null>(null);
  const starting = useRef(false);
  const press = useRef({ down: false, t0: 0, x0: 0, y0: 0 });
  const swallow = useRef(false);
  const speech = useRef<Dictation | null>(null);
  const Dict = dictation();

  const setRec = (r: Rec | null | ((x: Rec | null) => Rec | null)) => {
    const next = typeof r === "function" ? r(recRef.current) : r;
    recRef.current = next;
    setRecState(next);
  };

  // the box grows with what is typed or dictated, to a limit
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = text ? `${Math.min(el.scrollHeight, 168)}px` : "";
  }, [text]);

  useEffect(() => () => (taker.current?.cancel(), speech.current?.stop()), []);

  // ---- dictation: the words appear in the box as they are said
  const stopDictation = () => {
    speech.current?.stop();
    speech.current = null;
    setListening(false);
  };
  const dictate = () => {
    if (listening) return stopDictation();
    if (!Dict || recRef.current) return;
    setNote("");
    const base = text;
    const r = new Dict();
    r.lang = speechLang(LANGUAGE, navigator.language);
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      const spoken = Array.from(e.results).map((x) => x[0].transcript).join(" ");
      setText(joinDictation(base, spoken));
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setNote(t("voice.blocked"));
      else if (e.error === "network") setNote(t("voice.dictNetwork"));
      else if (e.error === "audio-capture") setNote(t("voice.noMic"));
    };
    r.onend = () => {
      setListening(false);
      speech.current = null;
    };
    speech.current = r;
    try {
      r.start();
      setListening(true);
      field.current?.focus();
    } catch {
      speech.current = null;
    }
  };

  // ---- a voice note
  const begin = async () => {
    if (taker.current || starting.current || busy) return;
    stopDictation();
    starting.current = true;
    setNote("");
    const rc = new Recorder({
      onLevel: (l) => setLevels((v) => pushLevel(v, l)),
      onTick: (s) => setRec((x) => (x ? { ...x, seconds: s } : x)),
      onLimit: () => void finish(true),
    });
    try {
      await rc.start();
    } catch (e) {
      starting.current = false;
      rc.cancel();
      setNote(micError(e));
      return;
    }
    taker.current = rc;
    starting.current = false;
    setLevels([]);
    // let go while the permission was asked: nothing to hold any more, so the note stays open
    setRec({ mode: press.current.down ? "hold" : "locked", seconds: 0, cancelling: false });
  };

  const finish = async (send: boolean) => {
    const rc = taker.current;
    if (!rc) return;
    taker.current = null;
    if (!send) {
      rc.cancel();
      setRec(null);
      return;
    }
    try {
      const take = await rc.stop();
      setRec(null);
      if (take.seconds < 0.6 || take.blob.size < 800) return setNote(t("voice.short"));
      if (take.blob.size > MAX_BYTES) return setNote(t("voice.big"));
      await onVoice(take);
    } catch (e) {
      setRec(null);
      setNote((e as Error).message);
    }
  };

  const down = (e: PointerEvent) => {
    e.preventDefault();
    swallow.current = true;
    setTimeout(() => (swallow.current = false), 600);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    press.current = { down: true, t0: performance.now(), x0: e.clientX, y0: e.clientY };
    void begin();
  };
  const move = (e: PointerEvent) => {
    const r = recRef.current;
    if (!press.current.down || r?.mode !== "hold") return;
    const cancelling = slidCancel(e.clientX - press.current.x0, e.clientY - press.current.y0);
    if (cancelling !== r.cancelling) setRec({ ...r, cancelling });
  };
  const up = (e: PointerEvent, cancelled = false) => {
    if (!press.current.down) return;
    press.current.down = false;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const r = recRef.current;
    // still opening the microphone: `begin` sees the finger is gone and keeps the note open
    if (!r || r.mode !== "hold") return;
    if (cancelled) return setRec({ ...r, mode: "locked", cancelling: false });
    if (r.cancelling) return void finish(false);
    if (performance.now() - press.current.t0 < 350) return setRec({ ...r, mode: "locked" });
    void finish(true);
  };
  // the keyboard and screen readers: Enter or Space starts a note that stays open
  const click = () => {
    if (swallow.current) {
      swallow.current = false;
      return;
    }
    press.current.down = false;
    void begin();
  };

  const typed = text.trim().length > 0;
  const recording = rec !== null;
  return (
    <form class="composer" onSubmit={(e) => (e.preventDefault(), onSend())}>
      <div class={`comp-box${recording ? " is-rec" : ""}${listening ? " is-listening" : ""}`}>
        <textarea
          ref={field}
          rows={1}
          hidden={recording}
          value={text}
          placeholder={listening ? t("voice.listening") : t("chat.ph")}
          aria-label={t("chat.ph")}
          enterkeyhint="send"
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (sendsOnEnter(e, matchMedia("(pointer: fine)").matches)) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <div class="comp-row">
          {rec
            ? (
              <div key="rec" class={`rec${rec.cancelling ? " cancelling" : ""}`} role="status" aria-label={t("voice.recording")}>
                <span class="rec-dot" aria-hidden="true" />
                <span class="rec-time">{clock(rec.seconds)}</span>
                <Meter levels={levels} />
                <span class="rec-hint">{rec.mode === "hold" ? (rec.cancelling ? t("voice.release") : t("voice.slide")) : ""}</span>
              </div>
            )
            : (
              <button key="machine" type="button" class="machine-chip" onClick={onMachine} aria-label={t("chat.machine")}>
                <Icon name="machine" size={15} />
                <span>{where}</span>
                <Icon name="down" size={13} />
              </button>
            )}
          {!recording && Dict && (
            <button
              key="dict"
              type="button"
              class={`tool${listening ? " on" : ""}`}
              aria-pressed={listening}
              aria-label={listening ? t("voice.dictStop") : t("voice.dict")}
              onClick={dictate}
            >
              <Icon name="dictate" size={20} />
            </button>
          )}
          {rec?.mode === "locked" && (
            <button key="cancel" type="button" class="tool danger" aria-label={t("voice.cancel")} onClick={() => void finish(false)}>
              <Icon name="x" size={20} />
            </button>
          )}
          {rec?.mode === "locked"
            ? (
              <button key="stop" type="button" class="send" aria-label={t("voice.send")} onClick={() => void finish(true)}>
                <Icon name="send" size={20} />
              </button>
            )
            : (
              <>
                {
                  /* the voice note is always offered: beside Send when the box has words, as the round button
                  when it is empty (the owner's choice, 2026-10-16) */
                }
                <button
                  key="voice"
                  type="button"
                  class={typed && !recording
                    ? "tool"
                    : `send voice${rec ? " hold" : ""}${rec?.cancelling ? " cancelling" : ""}`}
                aria-label={t("voice.note")}
                disabled={busy && !recording}
                onPointerDown={down}
                onPointerMove={move}
                onPointerUp={(e) => up(e)}
                onPointerCancel={(e) => up(e, true)}
                onContextMenu={(e) => e.preventDefault()}
                onClick={click}
              >
                  <Icon name="mic" size={20} />
                </button>
                {typed && !recording && (
                  <button key="send" type="submit" class="send" disabled={busy} aria-label={t("chat.send")}>
                    <Icon name="send" size={20} />
                  </button>
                )}
              </>
            )}
        </div>
      </div>
      {listening && <p class="comp-note" role="status">{t("voice.dictNote")}</p>}
      {note && <p class="comp-note warn" role="alert">{note}</p>}
    </form>
  );
}
