// chat.tsx — Chat on the phone. The list by day (a rail beside the conversation on a wide screen), and a
// conversation that follows its chat on the service's Server-Sent Events: the owner's messages are compact
// bubbles, the answers full-width text, the changes Claude made small chips under them. The composer stays
// above the keyboard.

import { useEffect, useRef, useState } from "preact/hooks";
import { Markdown } from "../lib/markdown.tsx";
import { cancelTurn, deleteChat, eventsOf, getChat, listChats, loadNodes, renameChat, sendTurn, sendVoice } from "./api.ts";
import { Composer } from "./composer.tsx";
import {
  type Act,
  actKind,
  applyEvent,
  cancellable,
  type ChatHead,
  filterChats,
  groupByDay,
  type NodeInfo,
  online,
  retryable,
  type Turn,
} from "./lib.ts";
import { go } from "./route.ts";
import { chatsTick, offline, pin, pinned } from "./state.ts";
import { Swipe } from "./swipe.tsx";
import { dateOf, t, tk } from "./t.ts";
import type { Take } from "./voice.ts";
import { Empty, Failure, Header, Icon, Mark, Sheet, Skeleton, toast, usePull } from "./ui.tsx";

const COPY = () => ({ label: t("copy"), done: t("copied") });
/** Turns just written, for a conversation that opens after the page went to its id (a new chat). */
const seeded = new Map<string, Turn[]>();

// ---- deleting a chat from the list waits a few seconds for an Undo; the delete itself is the service's, and goes at once
// if the page is closing
const UNDO_MS = 6000;
const pendingDeletes = new Map<string, () => void>();
const flushDeletes = () => [...pendingDeletes.values()].forEach((run) => run());
addEventListener("pagehide", flushDeletes);
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flushDeletes());

/** The chat goes from the list now and from the account when the Undo has run out. `restore` puts it back in view. */
function scheduleDelete(c: ChatHead, restore: () => void) {
  let settled = false;
  const run = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    pendingDeletes.delete(c.id);
    deleteChat(c.id).then(() => void chatsTick.value++, (e: Error) => (toast(e.message), restore()));
  };
  const timer = setTimeout(run, UNDO_MS);
  pendingDeletes.set(c.id, run);
  toast(t("chat.deleted"), {
    label: t("undo"),
    run: () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pendingDeletes.delete(c.id);
      restore();
    },
  }, UNDO_MS);
}

/** Renaming: one field, in a sheet. */
function RenameSheet({ id, title, onClose, onDone }: { id: string; title: string; onClose: () => void; onDone: (title: string) => void }) {
  const [name, setName] = useState(title);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const save = async (e: Event) => {
    e.preventDefault();
    const next = name.trim();
    if (!next || busy) return;
    setBusy(true);
    try {
      await renameChat(id, next);
      onDone(next);
    } catch (x) {
      setErr((x as Error).message);
      setBusy(false);
    }
  };
  return (
    <Sheet title={t("chat.rename")} onClose={onClose}>
      <form onSubmit={save}>
        <label class="field">
          <span>{t("chat.renameLabel")}</span>
          <input type="text" value={name} maxLength={120} autoFocus onInput={(e) => setName(e.currentTarget.value)} />
        </label>
        {err && <p class="err" role="alert">{err}</p>}
        <div class="sheet-actions">
          <button type="submit" class="btn primary" disabled={busy || !name.trim()}>{t("chat.save")}</button>
          <button type="button" class="btn" onClick={onClose}>{t("cancel")}</button>
        </div>
      </form>
    </Sheet>
  );
}

export function ChatList({ active }: { active?: string }) {
  const [chats, setChats] = useState<ChatHead[] | null>(null);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [menu, setMenu] = useState<{ chat: ChatHead; rename: boolean } | null>(null);
  const first = useRef<Set<string> | null>(null);
  const load = () =>
    listChats().then((c) => {
      const rows = c.filter((x) => !pendingDeletes.has(x.id));
      // what was there when the list first came is not animated in; what comes after is
      first.current ??= new Set(rows.map((x) => x.id));
      setChats(rows);
      setErr("");
    }, (e: Error) => setErr(e.message));
  const pull = usePull(load);
  useEffect(() => {
    void load();
    const again = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", again);
    return () => document.removeEventListener("visibilitychange", again);
  }, [chatsTick.value]);

  const remove = (c: ChatHead) => {
    setChats((all) => all?.filter((x) => x.id !== c.id) ?? null);
    scheduleDelete(c, () => void load());
  };
  const shown = chats ? filterChats(chats, q, t("chat.untitled")) : [];
  const groups = groupByDay(shown, (c) => c.updated, new Date());
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
      {chats && chats.length > 2 && (
        <div class="search" role="search">
          <Icon name="search" size={18} />
          <input type="search" value={q} placeholder={t("chat.search")} aria-label={t("chat.search")} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
      )}
      {err && <Failure text={err} retry={load} />}
      {!chats && !err && <Skeleton rows={6} />}
      {chats && !chats.length && !err && (
        <Empty icon="chat" text={t("chat.empty")}>
          <a class="btn primary" href="#chat/new">{t("chat.new")}</a>
        </Empty>
      )}
      {chats && chats.length > 0 && !shown.length && <Empty icon="search" text={t("chat.noMatch")} />}
      {groups.map((g) => (
        <section key={g.day}>
          <h2 class="day">{g.day === "today" || g.day === "yesterday" ? t(`day.${g.day}`) : dateOf(g.day, { day: "numeric", month: "long" })}</h2>
          <ul class="rows">
            {g.items.map((c) => (
              <li key={c.id} class={first.current && !first.current.has(c.id) ? "enter" : undefined}>
                <Swipe left={{ label: t("chat.delete"), tone: "crit", icon: "trash", leave: true, run: () => remove(c) }}>
                  <div class="row-wrap">
                    <a class={`row${c.id === active ? " on" : ""}`} href={`#chat/${encodeURIComponent(c.id)}`} aria-current={c.id === active ? "page" : undefined}>
                      <span class="row-t">{c.title || t("chat.untitled")}</span>
                      <span class="row-s">
                        {dateOf(c.updated, { hour: "2-digit", minute: "2-digit" })}
                        {c.node && <><i class="sep" aria-hidden="true" /><Icon name="machine" size={13} />{c.node}</>}
                      </span>
                    </a>
                    <button type="button" class="icon-btn row-more" aria-label={t("chat.actions", { t: c.title || t("chat.untitled") })} onClick={() => setMenu({ chat: c, rename: false })}>
                      <Icon name="more" size={20} />
                    </button>
                  </div>
                </Swipe>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {menu && !menu.rename && (
        <Sheet title={menu.chat.title || t("chat.untitled")} onClose={() => setMenu(null)}>
          <div class="sheet-actions">
            <button type="button" class="btn" onClick={() => setMenu({ ...menu, rename: true })}><Icon name="edit" size={18} />{t("chat.rename")}</button>
            <button type="button" class="btn danger-o" onClick={() => (remove(menu.chat), setMenu(null))}><Icon name="trash" size={18} />{t("chat.delete")}</button>
          </div>
        </Sheet>
      )}
      {menu?.rename && (
        <RenameSheet
          id={menu.chat.id}
          title={menu.chat.title}
          onClose={() => setMenu(null)}
          onDone={(title) => (setChats((all) => all?.map((x) => (x.id === menu.chat.id ? { ...x, title } : x)) ?? null), setMenu(null), void chatsTick.value++)}
        />
      )}
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

/** What the owner said: a bubble with the words, or for a voice note whose words have not come, a small audio bubble. */
function Question({ turn }: { turn: Turn }) {
  if (turn.voice && !turn.q) {
    return (
      <div class="bub voice-b" role="status">
        <span class="vb-i"><Icon name="wave" size={16} /></span>
        <span class="vb-bars" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></span>
        <span>{turn.state === "cancelled" ? t("voice.note") : t("voice.transcribing")}</span>
      </div>
    );
  }
  return (
    <div class="bub">
      {turn.voice && <small class="vtag"><Icon name="mic" size={12} />{t("voice.note")}</small>}
      {turn.q}
    </div>
  );
}

function Answer(
  { turn, onRetry, cancelling, onCancel }: { turn: Turn; onRetry: () => void; cancelling: boolean; onCancel: () => void },
) {
  const live = cancellable(turn);
  const [copied, setCopied] = useState(false);
  const noWords = turn.voice && !turn.q;
  const cancel = (
    <button type="button" class="btn small ghost" disabled={cancelling} onClick={onCancel}>
      {cancelling ? t("chat.cancelling") : t("cancel")}
    </button>
  );
  return (
    <div class="msg-a" aria-busy={live}>
      {turn.state === "waiting" && (
        <div class="status-b">
          <div class="status">
            <span class="dots" aria-hidden="true"><i /><i /><i /></span>
            <span>{noWords ? t("voice.waiting") : t("chat.waiting")}</span>
            {cancel}
          </div>
          {noWords && <p class="meta">{t("voice.noTranscriber")}</p>}
        </div>
      )}
      {turn.state === "running" && !turn.a && (
        <div class="status">
          <span class="dots" aria-hidden="true"><i /><i /><i /></span>
          <span>{noWords ? t("voice.transcribing") : turn.node ? t("chat.runningOn", { n: turn.node }) : t("chat.running")}</span>
          {cancel}
        </div>
      )}
      {turn.a && (
        <div class={`answer${turn.state === "running" ? " streaming" : ""}`}>
          <Markdown src={turn.a} copy={COPY()} />
          {turn.state === "running" && <span class="cursor" aria-hidden="true" />}
        </div>
      )}
      {turn.state === "running" && turn.a && <div class="status tail">{cancel}</div>}
      <Acts acts={turn.acts} />
      {turn.state === "failed" && (
        <div class="banner crit" role="alert">
          <Icon name="alert" size={18} />
          <span>{turn.error || t("chat.failed")}</span>
          {turn.q && retryable(turn) && <button type="button" class="btn small" onClick={onRetry}>{t("retry")}</button>}
        </div>
      )}
      {turn.state === "cancelled" && (
        <div class="banner" role="status">
          <Icon name="stop" size={16} />
          <span>{t("chat.cancelled")}</span>
          {turn.q && retryable(turn) && <button type="button" class="btn small" onClick={onRetry}>{t("retry")}</button>}
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
  const [sheet, setSheet] = useState<"machine" | "delete" | "rename" | null>(null);
  const [cancelling, setCancelling] = useState<string[]>([]);
  const [away, setAway] = useState(false);
  const now = useRef<Turn[]>(turns);
  const thread = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  // the turns the conversation opened with are not animated in; the ones that come after are
  const opened = useRef<Set<string> | null>(seeded.has(id) ? new Set() : null);
  const set = (x: Turn[]) => setTurns((now.current = x));

  // the chat, then its events; after a dropped connection the events missed are read again from the chat
  useEffect(() => {
    seeded.delete(id);
    if (fresh) return;
    let gone = false, connected = false;
    const load = () =>
      getChat(id).then((c) => {
        if (gone) return;
        opened.current ??= new Set(c.turns.map((x) => x.id));
        setTitle(c.title);
        set(c.turns);
        setLoaded(true);
        setErr("");
      }, (e: Error) => !gone && (setErr(e.message), setLoaded(true)));
    void load();
    const es = eventsOf(id);
    es.addEventListener("open", () => {
      if (connected) void load();
      connected = true;
    });
    for (const name of ["turn", "text", "act", "done", "transcript"]) {
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
        if (name === "turn" && (data.state === "cancelled" || data.state === "failed" || data.state === "done")) {
          setCancelling((c) => c.filter((x) => x !== data.turn));
        }
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

  /** A turn written (text or voice): it joins the thread now, and a new chat becomes the page's chat. */
  const accept = (r: { chat: string; turn: Turn | null }) => {
    chatsTick.value++;
    setErr("");
    stick.current = true;
    if (r.turn && !now.current.some((x) => x.id === r.turn!.id)) set([...now.current, r.turn]);
    if (fresh) {
      seeded.set(r.chat, now.current);
      go({ view: "chat", id: r.chat }, true);
    }
  };
  const post = async (q: string) => {
    setBusy(true);
    try {
      accept(await sendTurn(q, fresh ? undefined : id, pinned.value ?? undefined));
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const postVoice = async (take: Take) => {
    setBusy(true);
    try {
      accept(await sendVoice(take.blob, take.ext, fresh ? undefined : id, pinned.value ?? undefined));
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
    if (await post(q)) setText("");
  };

  const cancel = async (turn: Turn) => {
    setCancelling((c) => [...c, turn.id]);
    await cancelTurn(turn.id).catch((e: Error) => (setErr(e.message), setCancelling((c) => c.filter((x) => x !== turn.id))));
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
          <>
            <button type="button" class="icon-btn" aria-label={t("chat.rename")} onClick={() => setSheet("rename")}>
              <Icon name="edit" size={20} />
            </button>
            <button type="button" class="icon-btn" aria-label={t("chat.delete")} onClick={() => setSheet("delete")}>
              <Icon name="trash" size={20} />
            </button>
          </>
        )}
      />
      <div class="thread scroller" ref={thread} onScroll={onScroll} role="log" aria-label={t("chat.thread")}>
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
            <article key={x.id} class={opened.current && !opened.current.has(x.id) ? "enter" : undefined}>
              <div class="msg-u"><Question turn={x} /></div>
              <Answer
                turn={x}
                cancelling={cancelling.includes(x.id)}
                onCancel={() => void cancel(x)}
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
      <Composer
        text={text}
        setText={setText}
        field={field}
        busy={busy}
        where={where ?? t("chat.auto")}
        onMachine={() => setSheet("machine")}
        onSend={() => void send()}
        onVoice={postVoice}
      />
      {sheet === "machine" && <MachineSheet onClose={() => setSheet(null)} />}
      {sheet === "rename" && (
        <RenameSheet id={id} title={title} onClose={() => setSheet(null)} onDone={(next) => (setTitle(next), setSheet(null), void chatsTick.value++)} />
      )}
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
