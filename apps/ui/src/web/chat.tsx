// chat.tsx — Chat on the phone: the list by day, and a conversation that follows its chat on the service's
// Server-Sent Events (text pieces, the changes Claude made, the end), with a composer.

import { useEffect, useRef, useState } from "preact/hooks";
import { Markdown } from "../lib/markdown.tsx";
import { deleteChat, eventsOf, getChat, listChats, sendTurn } from "./api.ts";
import { type Act, applyEvent, type ChatHead, groupByDay, type Turn } from "./lib.ts";
import { go } from "./route.ts";
import { dateOf, t } from "./t.ts";
import { Empty, Failure, Header } from "./ui.tsx";

export function ChatList() {
  const [chats, setChats] = useState<ChatHead[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => listChats().then((c) => (setChats(c), setErr("")), (e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
    const again = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, []);
  const groups = chats ? groupByDay(chats, (c) => c.updated, new Date()) : [];
  return (
    <>
      <Header title={t("chat.title")} action={<a class="btn" href="#chat/new">{t("chat.new")}</a>} />
      {err && <Failure text={err} retry={load} />}
      {chats && !chats.length && !err && <Empty text={t("chat.empty")} />}
      {groups.map((g) => (
        <section key={g.day}>
          <h2 class="day">{g.day === "today" || g.day === "yesterday" ? t(`day.${g.day}`) : dateOf(g.day, { day: "numeric", month: "long" })}</h2>
          <ul class="rows">
            {g.items.map((c) => (
              <li key={c.id}>
                <a class="row" href={`#chat/${encodeURIComponent(c.id)}`}>
                  <span class="row-t">{c.title || t("chat.untitled")}</span>
                  <span class="row-s">
                    {dateOf(c.updated, { hour: "2-digit", minute: "2-digit" })}
                    {c.node ? ` · ${c.node}` : ""}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

/** What Claude did with its tools: the changes as chips. */
function Acts({ acts }: { acts: Act[] }) {
  const changes = acts.filter((x) => x.d);
  if (!changes.length) return null;
  return (
    <div class="acts">
      {changes.map((x, i) => (
        <span key={i} class="act">
          <b>{x.n.replace(/_/g, " ")}</b> {x.d}
        </span>
      ))}
    </div>
  );
}

function Answer({ turn }: { turn: Turn }) {
  const live = turn.state === "waiting" || turn.state === "running";
  return (
    <div class="msg-a">
      {turn.state === "waiting" && <p class="wait">{t("chat.waiting")}</p>}
      {turn.a && <Markdown src={turn.a} />}
      {turn.state === "running" && !turn.a && <p class="wait">{turn.node ? t("chat.runningOn", { n: turn.node }) : t("chat.running")}</p>}
      {live && <span class="dots" aria-hidden="true"><i /><i /><i /></span>}
      <Acts acts={turn.acts} />
      {turn.state === "failed" && <p class="err">{turn.error || t("chat.failed")}</p>}
      {turn.state === "done" && turn.node && <p class="meta">{t("chat.ranOn", { n: turn.node })}</p>}
    </div>
  );
}

export function Conversation({ id }: { id: string }) {
  const fresh = id === "new";
  const [turns, setTurns] = useState<Turn[]>([]);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const now = useRef<Turn[]>([]);
  const thread = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const set = (x: Turn[]) => setTurns((now.current = x));

  // the chat, then its events; after a dropped connection the events missed are read again from the chat
  useEffect(() => {
    if (fresh) return;
    let gone = false, opened = false;
    const load = () =>
      getChat(id).then((c) => {
        if (gone) return;
        setTitle(c.title);
        set(c.turns);
        setErr("");
      }, (e: Error) => !gone && setErr(e.message));
    void load();
    const es = eventsOf(id);
    es.addEventListener("open", () => {
      if (opened) void load();
      opened = true;
    });
    for (const name of ["turn", "text", "act", "done"]) {
      es.addEventListener(name, (e) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse((e as MessageEvent<string>).data);
        } catch {
          return;
        }
        const next = applyEvent(now.current, name, data);
        if (next) set(next);
        else void load();
      });
    }
    return () => {
      gone = true;
      es.close();
    };
  }, [id]);

  // the end of the thread stays in view while an answer is written, unless the reader scrolled up
  useEffect(() => {
    const el = thread.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTo({ top: el.scrollHeight });
  }, [turns]);

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    try {
      const r = await sendTurn(q, fresh ? undefined : id);
      setText("");
      if (field.current) field.current.style.height = "";
      setErr("");
      if (fresh) go({ view: "chat", id: r.chat }, true);
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  const forget = async () => {
    if (!confirm(t("chat.forget"))) return;
    await deleteChat(id).then(() => go({ view: "chat" }), (e: Error) => setErr(e.message));
  };

  return (
    <div class="convo">
      <Header
        title={fresh ? t("chat.new") : title || t("chat.untitled")}
        back="#chat"
        action={fresh ? undefined : <button type="button" class="btn ghost" onClick={forget}>{t("chat.delete")}</button>}
      />
      <div class="thread" ref={thread}>
        {fresh && !turns.length && <Empty text={t("chat.start")} />}
        {turns.map((x) => (
          <article key={x.id}>
            <div class="msg-u"><div class="bub">{x.q}</div></div>
            <Answer turn={x} />
          </article>
        ))}
      </div>
      {err && <p class="err bar" role="alert">{err}</p>}
      <form class="composer" onSubmit={(e) => (e.preventDefault(), void send())}>
        <textarea
          ref={field}
          rows={1}
          value={text}
          placeholder={t("chat.ph")}
          aria-label={t("chat.ph")}
          enterkeyhint="send"
          onInput={(e) => {
            const el = e.currentTarget;
            setText(el.value);
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button type="submit" class="send" disabled={busy || !text.trim()} aria-label={t("chat.send")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
        </button>
      </form>
    </div>
  );
}
