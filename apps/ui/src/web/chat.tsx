// chat.tsx — Chat on the phone. The list by day (a rail beside the conversation on a wide screen), and a
// conversation that follows its chat on the service's Server-Sent Events: the owner's messages are compact
// bubbles, the answers full-width text, the changes Claude made small chips under them. The composer stays
// above the keyboard.

import { useEffect, useRef, useState } from "preact/hooks";
import { Markdown } from "../lib/markdown.tsx";
import { deleteChat, eventsOf, getChat, listChats, loadNodes, sendTurn } from "./api.ts";
import { type Act, actKind, applyEvent, type ChatHead, groupByDay, type NodeInfo, online, sendsOnEnter, type Turn } from "./lib.ts";
import { go } from "./route.ts";
import { chatsTick, offline, pin, pinned } from "./state.ts";
import { dateOf, t, tk } from "./t.ts";
import { Empty, Failure, Header, Icon, Mark, Sheet, Skeleton, usePull } from "./ui.tsx";

const COPY = () => ({ label: t("copy"), done: t("copied") });
/** Turns just written, for a conversation that opens after the page went to its id (a new chat). */
const seeded = new Map<string, Turn[]>();

export function ChatList({ active }: { active?: string }) {
  const [chats, setChats] = useState<ChatHead[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => listChats().then((c) => (setChats(c), setErr("")), (e: Error) => setErr(e.message));
  const pull = usePull(load);
  useEffect(() => {
    void load();
    const again = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [chatsTick.value]);
  const groups = chats ? groupByDay(chats, (c) => c.updated, new Date()) : [];
  return (
    <>
      {pull.indicator}
      <Header
        large
        title={t("chat.title")}
        action={
          <a class="btn primary round" href="#chat/new" aria-label={t("chat.new")}>
            <Icon name="plus" size={20} />
            <span class="lbl">{t("chat.new")}</span>
          </a>
        }
      />
      {err && <Failure text={err} retry={load} />}
      {!chats && !err && <Skeleton rows={6} />}
      {chats && !chats.length && !err && (
        <Empty icon="chat" text={t("chat.empty")}>
          <a class="btn primary" href="#chat/new">{t("chat.new")}</a>
        </Empty>
      )}
      {groups.map((g) => (
        <section key={g.day}>
          <h2 class="day">{g.day === "today" || g.day === "yesterday" ? t(`day.${g.day}`) : dateOf(g.day, { day: "numeric", month: "long" })}</h2>
          <ul class="rows">
            {g.items.map((c) => (
              <li key={c.id}>
                <a class={`row${c.id === active ? " on" : ""}`} href={`#chat/${encodeURIComponent(c.id)}`} aria-current={c.id === active ? "page" : undefined}>
                  <span class="row-t">{c.title || t("chat.untitled")}</span>
                  <span class="row-s">
                    {dateOf(c.updated, { hour: "2-digit", minute: "2-digit" })}
                    {c.node && <><i class="sep" aria-hidden="true" /><Icon name="machine" size={13} />{c.node}</>}
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
    <ul class="acts" aria-label={t("chat.changes")}>
      {changes.map((x, i) => (
        <li key={i} class={`act ${actKind(x.n)}`}>
          <Icon name={({ task: "task", brain: "brain", calendar: "calendar", mail: "mail", job: "job", other: "tool" } as const)[actKind(x.n)]} size={14} />
          <b>{tk(`act.${x.n}`) ?? x.n.replace(/_/g, " ")}</b>
          <span>{x.d}</span>
        </li>
      ))}
    </ul>
  );
}

function copyText(text: string) {
  if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => {});
}

function Answer({ turn, onRetry, stopped, onStop }: { turn: Turn; onRetry: () => void; stopped: boolean; onStop: () => void }) {
  const live = (turn.state === "waiting" || turn.state === "running") && !stopped;
  const [copied, setCopied] = useState(false);
  return (
    <div class="msg-a" aria-busy={live}>
      {turn.state === "waiting" && !stopped && (
        <div class="status">
          <span class="dots" aria-hidden="true"><i /><i /><i /></span>
          <span>{t("chat.waiting")}</span>
          <button type="button" class="btn small ghost" onClick={onStop}>{t("chat.stopWaiting")}</button>
        </div>
      )}
      {turn.state === "waiting" && stopped && <p class="status quiet">{t("chat.stopped")}</p>}
      {turn.state === "running" && !turn.a && (
        <div class="status">
          <span class="dots" aria-hidden="true"><i /><i /><i /></span>
          <span>{turn.node ? t("chat.runningOn", { n: turn.node }) : t("chat.running")}</span>
        </div>
      )}
      {turn.a && (
        <div class="answer">
          <Markdown src={turn.a} copy={COPY()} />
          {turn.state === "running" && <span class="cursor" aria-hidden="true" />}
        </div>
      )}
      <Acts acts={turn.acts} />
      {turn.state === "failed" && (
        <div class="banner crit" role="alert">
          <Icon name="alert" size={18} />
          <span>{turn.error || t("chat.failed")}</span>
          <button type="button" class="btn small" onClick={onRetry}>{t("retry")}</button>
        </div>
      )}
      {turn.state === "done" && (
        <div class="foot">
          {turn.node && <span><Icon name="machine" size={13} />{t("chat.ranOn", { n: turn.node })}</span>}
          <button
            type="button"
            class="btn small ghost"
            aria-label={t("chat.copyAnswer")}
            onClick={() => (copyText(turn.a), setCopied(true), setTimeout(() => setCopied(false), 1600))}
          >
            <Icon name={copied ? "check" : "copy"} size={15} />
            {copied ? t("copied") : t("copy")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Which machine answers: the account's choice, or this one for the next messages. */
function MachineSheet({ onClose }: { onClose: () => void }) {
  const [nodes, setNodes] = useState<{ nodes: NodeInfo[]; now: string } | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    loadNodes().then(setNodes, (e: Error) => setErr(e.message));
  }, []);
  const choose = (n: string | null) => (pin(n), onClose());
  return (
    <Sheet title={t("chat.machine")} onClose={onClose}>
      <p class="meta">{t("chat.machineHelp")}</p>
      {err && <Failure text={err} />}
      {!nodes && !err && <Skeleton rows={3} />}
      <ul class="pick" role="radiogroup" aria-label={t("chat.machine")}>
        <li>
          <button type="button" role="radio" aria-checked={!pinned.value} onClick={() => choose(null)}>
            <span><b>{t("chat.auto")}</b><small>{t("chat.autoHelp")}</small></span>
            {!pinned.value && <Icon name="check" size={18} />}
          </button>
        </li>
        {nodes?.nodes.map((n) => {
          const on = online(n, nodes.now);
          return (
            <li key={n.name}>
              <button type="button" role="radio" aria-checked={pinned.value === n.name} onClick={() => choose(n.name)}>
                <span class={`dot ${on ? "on" : "off"}`} aria-hidden="true" />
                <span>
                  <b>{n.name}</b>
                  <small>{on ? t("machines.online") : t("machines.offline")} · {n.headless ? t("machines.server") : t("machines.desktop")}</small>
                </span>
                {pinned.value === n.name && <Icon name="check" size={18} />}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

export function Conversation({ id }: { id: string }) {
  const fresh = id === "new";
  const [turns, setTurns] = useState<Turn[]>(() => seeded.get(id) ?? []);
  const [title, setTitle] = useState("");
  const [loaded, setLoaded] = useState(fresh || seeded.has(id));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sheet, setSheet] = useState<"machine" | "delete" | null>(null);
  const [stopped, setStopped] = useState<string[]>([]);
  const [away, setAway] = useState(false);
  const now = useRef<Turn[]>(turns);
  const thread = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const set = (x: Turn[]) => setTurns((now.current = x));

  // the chat, then its events; after a dropped connection the events missed are read again from the chat
  useEffect(() => {
    seeded.delete(id);
    if (fresh) return;
    let gone = false, opened = false;
    const load = () =>
      getChat(id).then((c) => {
        if (gone) return;
        setTitle(c.title);
        set(c.turns);
        setLoaded(true);
        setErr("");
      }, (e: Error) => !gone && (setErr(e.message), setLoaded(true)));
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
        if (name === "done" || name === "turn") chatsTick.value++;
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
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight });
  }, [turns]);
  const onScroll = () => {
    const el = thread.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    setAway(!stick.current);
  };

  const post = async (q: string) => {
    setBusy(true);
    try {
      const r = await sendTurn(q, fresh ? undefined : id, pinned.value ?? undefined);
      chatsTick.value++;
      setErr("");
      stick.current = true;
      if (r.turn && !now.current.some((x) => x.id === r.turn!.id)) set([...now.current, r.turn]);
      if (fresh) {
        seeded.set(r.chat, now.current);
        go({ view: "chat", id: r.chat }, true);
      }
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    if (await post(q)) {
      setText("");
      if (field.current) field.current.style.height = "";
    }
  };

  const forget = async () => {
    setSheet(null);
    await deleteChat(id).then(() => (chatsTick.value++, go({ view: "chat" })), (e: Error) => setErr(e.message));
  };

  const lastNode = [...turns].reverse().find((x) => x.node)?.node;
  const where = pinned.value ?? lastNode;
  return (
    <div class="convo">
      <Header
        title={fresh ? t("chat.new") : title || t("chat.untitled")}
        back="#chat"
        action={fresh ? undefined : (
          <button type="button" class="icon-btn" aria-label={t("chat.delete")} onClick={() => setSheet("delete")}>
            <Icon name="trash" size={20} />
          </button>
        )}
      />
      <div class="thread" ref={thread} onScroll={onScroll} role="log" aria-label={t("chat.thread")}>
        <div class="thread-in">
          {!loaded && <Skeleton rows={3} tall />}
          {fresh && !turns.length && (
            <div class="hello">
              <Mark size={44} />
              <h2>{t("chat.hello")}</h2>
              <p>{t("chat.start")}</p>
              <div class="chips">
                {(["chat.s1", "chat.s2", "chat.s3"] as const).map((k) => (
                  <button key={k} type="button" class="chip" onClick={() => (setText(t(k)), field.current?.focus())}>{t(k)}</button>
                ))}
              </div>
            </div>
          )}
          {turns.map((x) => (
            <article key={x.id}>
              <div class="msg-u"><div class="bub">{x.q}</div></div>
              <Answer
                turn={x}
                stopped={stopped.includes(x.id)}
                onStop={() => setStopped([...stopped, x.id])}
                onRetry={() => void post(x.q)}
              />
            </article>
          ))}
        </div>
        {away && (
          <button type="button" class="jump" onClick={() => (stick.current = true, thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" }))}>
            <Icon name="down" size={16} />{t("chat.latest")}
          </button>
        )}
      </div>
      {offline.value && <p class="inline-note" role="status">{t("chat.offline")}</p>}
      {err && <Failure text={err} />}
      <form class="composer" onSubmit={(e) => (e.preventDefault(), void send())}>
        <div class="comp-box">
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
              el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
            }}
            onKeyDown={(e) => {
              if (sendsOnEnter(e, matchMedia("(pointer: fine)").matches)) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div class="comp-row">
            <button type="button" class="machine-chip" onClick={() => setSheet("machine")} aria-label={t("chat.machine")}>
              <Icon name="machine" size={15} />
              <span>{where ?? t("chat.auto")}</span>
              <Icon name="down" size={13} />
            </button>
            <button type="submit" class="send" disabled={busy || !text.trim()} aria-label={t("chat.send")}>
              <Icon name="send" size={20} />
            </button>
          </div>
        </div>
      </form>
      {sheet === "machine" && <MachineSheet onClose={() => setSheet(null)} />}
      {sheet === "delete" && (
        <Sheet title={t("chat.forget")} onClose={() => setSheet(null)}>
          <p class="meta">{t("chat.forgetHelp")}</p>
          <div class="sheet-actions">
            <button type="button" class="btn danger" onClick={forget}>{t("chat.delete")}</button>
            <button type="button" class="btn" onClick={() => setSheet(null)}>{t("cancel")}</button>
          </div>
        </Sheet>
      )}
    </div>
  );
}

/** The wide screen's right pane when no chat is open. */
export const Pick = () => (
  <div class="pick-none">
    <Mark size={48} />
    <p>{t("chat.pick")}</p>
    <a class="btn primary" href="#chat/new">{t("chat.new")}</a>
  </div>
);
