// chat/index.tsx — the Chat page: talking to Claude as in Claude Desktop. On the left the chats, the last
// spoken in first, by day; on the right the open one: what was asked on the right in a bubble, Claude's
// answers as text, with the changes it made (a task, an event, a page of the brain) as chips and what it
// read in a line; the answer being written streams in place, and Stop keeps what came so far. Below, the
// composer: Enter sends, Shift Enter goes to a new line, the model is chosen beside it. A chat can go on
// in a terminal (Claude Code resumes its session), and an answer that names a project's folder opens
// Claude Code there. The state lives in store.ts, so an answer goes on while another view is on screen.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, type Result } from "../../api.ts";
import { t, tk } from "../../i18n.ts";
import { Spark } from "../../lib/claude.tsx";
import { renderMarkdown } from "../../lib/markdown.tsx";
import { ModelPicker, useAskModel } from "../../lib/model-picker.tsx";
import { toast } from "../../lib/ui.tsx";
import { useIntent } from "../../router.ts";
import { owner, useTopic } from "../../state.ts";
import {
  type Act,
  answering,
  type ChatHead,
  chats,
  current,
  focusComposer,
  forget,
  live,
  loadChats,
  newChat,
  openChat,
  send,
  stop,
  syncOpen,
  type Turn,
} from "./store.ts";
import "./chat.css";

const folderName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || "~";

async function terminal(body: Record<string, unknown>): Promise<void> {
  const r = await api.terminal(body).catch((e: Error): Result => ({ ok: false, message: e.message }));
  if (!r.ok) toast(r.message ?? "", true);
}

/* ---------------- the list ---------------- */

type Group = "today" | "yesterday" | "week" | "older";

/** Pure: which day group a chat's last turn falls in. */
function groupOf(iso: string, now = new Date()): Group {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(new Date(iso))) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : days < 7 ? "week" : "older";
}

function ChatRow({ c, on }: { c: ChatHead; on: boolean }) {
  const [asking, setAsking] = useState(false);
  return (
    <div class={`chl-r${on ? " on" : ""}`}>
      <button type="button" class="chl-t" title={c.title} onClick={() => void openChat(c.id).catch(() => {})}>
        {c.title || t("chat.untitled")}
      </button>
      {asking
        ? (
          <span class="chl-ask">
            <button
              type="button"
              class="bt sm danger"
              onClick={() =>
                void forget(c.id).then((r) => {
                  if (!r.ok) toast(r.message ?? t("chat.forgetFailed"), true);
                })}
            >
              {t("chat.forget")}
            </button>
            <button type="button" class="bt sm ghost" onClick={() => setAsking(false)}>{t("chat.keep")}</button>
          </span>
        )
        : (
          <button type="button" class="chl-x" title={t("chat.forget")} aria-label={t("chat.forget")} onClick={() => setAsking(true)}>
            <svg viewBox="0 0 16 16">
              <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
            </svg>
          </button>
        )}
    </div>
  );
}

function ChatList() {
  const list = chats.value;
  const id = current.value.id;
  const groups = new Map<Group, ChatHead[]>();
  for (const c of list ?? []) {
    const g = groupOf(c.updated);
    groups.set(g, [...groups.get(g) ?? [], c]);
  }
  return (
    <aside class="chl" aria-label={t("chat.list")}>
      <button type="button" class="chl-new" onClick={newChat}>
        <svg viewBox="0 0 16 16">
          <path d="M8 3v10M3 8h10" />
        </svg>
        {t("chat.new")}
      </button>
      <div class="chl-scroll">
        {list && !list.length && <p class="chl-none">{t("chat.none")}</p>}
        {(["today", "yesterday", "week", "older"] as const).map((g) =>
          groups.has(g) && (
            <section key={g}>
              <h6 class="chl-h">{t(`chat.g.${g}`)}</h6>
              {groups.get(g)!.map((c) => <ChatRow key={c.id} c={c} on={c.id === id} />)}
            </section>
          )
        )}
      </div>
    </aside>
  );
}

/* ---------------- the thread ---------------- */

/** What Claude did with its tools: the changes as chips, the reads in a line. */
function Acts({ acts }: { acts: Act[] }) {
  const changes = acts.filter((x) => x.d);
  const read = [...new Set(acts.filter((x) => !x.d).map((x) => x.k))];
  if (!changes.length && !read.length) return null;
  return (
    <div class="msg-acts">
      {read.length > 0 && <span class="msg-read">{t("chat.read", { w: read.map((k) => tk(`chat.k.${k}`)).join(", ") })}</span>}
      {changes.map((x, i) => (
        <span key={i} class={`msg-act ${x.k}`}>
          <b>{tk(`ask.act.${x.n}`)}</b>
          <span>{x.d}</span>
        </span>
      ))}
    </div>
  );
}

function Question({ q }: { q: string }) {
  return (
    <div class="msg-u">
      <div class="bub">{q}</div>
    </div>
  );
}

function Answer({ turn, retry }: { turn: Turn; retry?: () => void }) {
  const copy = () =>
    navigator.clipboard.writeText(turn.a).then(() => toast(t("chat.copied")), () => toast(t("chat.copyFailed"), true));
  return (
    <div class="msg-a">
      <Spark />
      <div class="msg-b">
        <Acts acts={turn.acts} />
        {turn.a && <div class="md">{renderMarkdown(turn.a)}</div>}
        {turn.error && (
          <p class="msg-err">
            {t("ask.failed", { e: turn.error })}
            {retry && <button type="button" class="bt sm ghost" onClick={retry}>{t("chat.retry")}</button>}
          </p>
        )}
        <div class="msg-f">
          {turn.code && (
            <button type="button" class="bt sm pri" onClick={() => void terminal({ cwd: turn.code, ask: turn.q })}>
              {t("ask.code", { p: folderName(turn.code) })}
            </button>
          )}
          {turn.a && (
            <button type="button" class="msg-tb" title={t("chat.copy")} onClick={() => void copy()}>
              <svg viewBox="0 0 16 16">
                <rect x="5" y="5" width="8" height="8" rx="1.5" />
                <path d="M3 10.5V4a1 1 0 0 1 1-1h6.5" />
              </svg>
              {t("chat.copy")}
            </button>
          )}
          {turn.model && <small class="msg-m">{tk(`ask.model.${turn.model}`)}</small>}
        </div>
      </div>
    </div>
  );
}

function Writing() {
  const l = live.value!;
  return (
    <>
      <Question q={l.q} />
      <div class="msg-a">
        <Spark mode={l.state} />
        <div class="msg-b">
          <Acts acts={l.acts} />
          {l.a ? <div class="md">{renderMarkdown(l.a)}</div> : null}
          <p class="msg-doing" role="status">{l.state === "writing" ? "" : `${l.doing}…`}</p>
        </div>
      </div>
    </>
  );
}

/** Good morning / afternoon / evening, by the clock. */
function greeting(): string {
  const h = new Date().getHours();
  const name = owner.value.name;
  const k = h < 5 ? "evening" : h < 12 ? "morning" : h < 18 ? "afternoon" : "evening";
  // "the user" is owner.json's default: no name given
  return name && name !== "the user" ? tk(`chat.hi.${k}.name`, { n: name }) : tk(`chat.hi.${k}`);
}

const SUGGEST = ["chat.s.today", "chat.s.waiting", "chat.s.mail"] as const;

/* ---------------- the composer ---------------- */

function Composer({ big }: { big: boolean }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const { state: models, pick } = useAskModel((m) => toast(m, true));
  const busy = !!live.value;

  useEffect(() => {
    ta.current?.focus();
  }, [focusComposer.value, current.value.id]);

  // "/" anywhere outside a field puts the cursor here; Esc stops an answer being written
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && answering()) {
        stop();
        return;
      }
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as Element)?.closest?.("input, textarea, select, [contenteditable]")) return;
      e.preventDefault();
      ta.current?.focus();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const autosize = () => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  };

  // the composer shrinks back to its text once the chat has begun
  useLayoutEffect(autosize, [big]);

  const submit = (e: Event) => {
    e.preventDefault();
    const el = ta.current!;
    const text = el.value.trim();
    if (!text || busy) return;
    el.value = "";
    autosize();
    void send(text);
  };

  useIntent("chat.new", () => {
    newChat();
    ta.current?.focus();
  });

  return (
    <form class={`cmp${big ? " big" : ""}`} onSubmit={submit}>
      <textarea
        ref={ta}
        name="text"
        rows={big ? 3 : 1}
        autocomplete="off"
        aria-label={t("chat.label")}
        placeholder={t(current.value.turns.length ? "chat.ph.more" : "chat.ph")}
        onInput={autosize}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            (e.currentTarget.form as HTMLFormElement).requestSubmit();
          }
        }}
      />
      <div class="cmp-f">
        {models && <ModelPicker state={models} onPick={(m) => void pick(m)} onDone={() => ta.current?.focus()} />}
        <span class="cmp-hint">{t("chat.hint")}</span>
        {busy
          ? (
            <button type="button" class="cmp-go stop" title={t("chat.stop")} aria-label={t("chat.stop")} onClick={stop}>
              <svg viewBox="0 0 20 20">
                <rect x="6" y="6" width="8" height="8" rx="1.5" />
              </svg>
            </button>
          )
          : (
            <button type="submit" class="cmp-go" title={t("ask.send")} aria-label={t("ask.send")}>
              <svg viewBox="0 0 20 20">
                <path d="M10 16V4M5 9l5-5 5 5" />
              </svg>
            </button>
          )}
      </div>
    </form>
  );
}

/* ---------------- the page ---------------- */

export function Chat() {
  const c = current.value;
  const l = live.value;
  const showLive = !!l && l.chat === c.id;
  const empty = !c.turns.length && !showLive;
  const scroll = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useTopic(async () => {
    await loadChats();
    await syncOpen();
  }, ["chats"]);

  // follow the answer as it grows, unless the reader scrolled up
  useLayoutEffect(() => {
    const el = scroll.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [c.id, c.turns.length, l?.a, l?.acts.length]);
  useEffect(() => {
    stick.current = true;
  }, [c.id]);

  const retry = (q: string) => () => void send(q);

  return (
    <div class="cht">
      <ChatList />
      <main class={`cht-main${empty ? " empty" : ""}`}>
        {!empty && (
          <header class="cht-h">
            <h1>{c.title || t("chat.new")}</h1>
            {c.session && !showLive && (
              <button type="button" class="bt sm ghost" onClick={() => void terminal({ resume: c.session })}>
                {t("ask.terminal")}
              </button>
            )}
          </header>
        )}
        <div
          class="cht-scroll"
          ref={scroll}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {empty
            ? (
              <div class="cht-hi">
                <Spark />
                <h2>{greeting()}</h2>
              </div>
            )
            : (
              <div class="cht-thread">
                {c.turns.map((x, i) => (
                  <div class="turn" key={`${c.id}-${i}`}>
                    <Question q={x.q} />
                    <Answer turn={x} retry={i === c.turns.length - 1 && !l ? retry(x.q) : undefined} />
                  </div>
                ))}
                {showLive && <Writing />}
              </div>
            )}
        </div>
        <div class="cht-foot">
          <Composer big={empty} />
          {empty && (
            <div class="cht-sug">
              {SUGGEST.map((k) => (
                <button type="button" class="chip" key={k} onClick={() => void send(t(k))}>{t(k)}</button>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
