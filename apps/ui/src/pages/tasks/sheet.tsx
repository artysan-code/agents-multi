// sheet.tsx — one task's page, in the drawer: its properties, steps, links, description, decisions, log
// and attachments. It follows what a chat changes (the "tasks" topic) without taking away what is being
// typed: every field keeps its draft until it is saved, and the description's draft wins while it is open.
// Writes run one after the other, each with the version the previous one returned.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { request } from "../../router.ts";
import { owner, useTopic } from "../../state.ts";
import { t, tk } from "../../i18n.ts";
import { ago } from "../../lib/format.ts";
import { renderMarkdown } from "../../lib/markdown.tsx";
import { closeDrawer, openDrawer, toast, toastErr } from "../../lib/ui.tsx";
import {
  type Attachment,
  type Item,
  type LinkedTask,
  loadItem,
  type NoteLine,
  openPath,
  taskOp,
  uploadFile,
} from "./api.ts";
import { board, COLS, dayLabel, isOpen, refreshBoard } from "./model.ts";

/** The description is the notes up to the first section the page manages (steps, log, decisions, attachments). */
const MANAGED =
  /^##\s+(steps|passi|log|diario|decisions|decisioni|attachments|allegati)\s*$/im;

function splitNotes(notes = ""): { desc: string; rest: string } {
  const m = notes.match(MANAGED);
  return m
    ? {
      desc: notes.slice(0, m.index).trim(),
      rest: notes.slice(m.index).trim(),
    }
    : { desc: notes.trim(), rest: "" };
}

const refOf = (l: LinkedTask): string => l.ref ?? l.id;
const list = (s: string): string[] =>
  s.split(",").map((y) => y.trim()).filter(Boolean);

/** Where the detail of a task is, as something the console opens: a URL, a brain page, or a file
 *  (a path relative to the project's folder, ~/…, or absolute; the #anchor is dropped). */
function detailTarget(d: string, folder: string | null): Attachment {
  if (/^https?:\/\//.test(d)) return { kind: "url", target: d, label: d };
  const page = d.match(/^\[\[([^\]|]+)/);
  if (page) return { kind: "page", target: page[1], label: d };
  const path = d.replace(/#.*$/, "");
  return {
    kind: "path",
    target: path.startsWith("/") || path.startsWith("~/")
      ? path
      : folder
      ? `~/${folder}/${path}`
      : path,
    label: d,
  };
}

/** A wiki page opens in the brain's reader. */
function openAttachment(a: Attachment | undefined): void {
  if (!a) return;
  if (a.kind === "url") {
    open(a.target, "_blank", "noopener");
  } else if (a.kind === "page") {
    closeDrawer();
    request("brain.open", "brain", a.target);
  } else void openPath(a.target);
}

const ICON: Record<Attachment["kind"], string> = {
  url:
    "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  path:
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  page: "M8.3 7l7.4.7M7 8.3l2.2 7.4",
};

function Ico({ kind }: { kind: Attachment["kind"] }) {
  return (
    <svg viewBox="0 0 24 24" class="ico">
      <path d={ICON[kind]} />
      {kind === "page" && (
        <>
          <circle cx="6" cy="6" r="2.5" />
          <circle cx="18" cy="8" r="2.5" />
          <circle cx="10" cy="18" r="2.5" />
        </>
      )}
    </svg>
  );
}

/** Opens a task's page in the drawer; one that is already open is replaced. */
export async function openTask(id: string): Promise<void> {
  let first: Item;
  try {
    first = await loadItem(id);
  } catch (e) {
    return toastErr(e);
  }
  openDrawer(t("title.tasks"), () => <Sheet key={id} id={id} first={first} />, {
    wide: true,
  });
}

type Save = (name: string, raw: string) => Promise<void>;

/** A property: it shows its draft until saved, so a redraw (a chat's change) never eats what is typed.
 *  A refused value goes back to the saved one. */
function Field(
  { name, value, onSave, children, ...rest }: {
    name: string;
    value: string;
    onSave: Save;
    children?: ComponentChildren;
    select?: boolean;
    [attr: string]: unknown;
  },
) {
  const [draft, setDraft] = useState<string | null>(null);
  const { select, ...attrs } = rest;
  const shown = draft ?? value;
  const common = {
    name,
    value: shown,
    onInput: (e: Event) =>
      setDraft((e.currentTarget as HTMLInputElement).value),
    onChange: async (e: Event) => {
      const v = (e.currentTarget as HTMLInputElement).value;
      setDraft(v);
      await onSave(name, v);
      setDraft(null);
    },
  };
  return select ? <select {...common} class="sel">{children}</select> : (
    <input
      {...common}
      {...attrs}
      class={attrs.class as string ?? "search"}
      autocomplete="off"
    />
  );
}

function Prop(
  { label, wide, children }: {
    label: string;
    wide?: boolean;
    children: ComponentChildren;
  },
) {
  return (
    <label class={wide ? "wide" : undefined}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Links({ items }: { items: LinkedTask[] }) {
  return (
    <ul class="ts-links">
      {items.map((l) => (
        <li key={l.id}>
          <button
            type="button"
            class={`ts-link${isOpen(l) ? "" : " closed"}`}
            onClick={() => openTask(l.id)}
          >
            {l.ref && <span class="tc-ref">{l.ref}</span>}
            <span>{l.title}</span>
            <small>{tk(`tb.col.${l.status}`)}</small>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A line that is added with Enter: steps, decisions, the log, attachments. */
function AddRow(
  { ph, onAdd, button }: {
    ph: string;
    onAdd: (v: string) => Promise<void>;
    button?: string;
  },
) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <form
      class="ts-row"
      onSubmit={async (e) => {
        e.preventDefault();
        const el = input.current!, v = el.value.trim();
        if (!v) return;
        el.value = ""; // before the redraw
        await onAdd(v);
        input.current?.focus();
      }}
    >
      <input
        ref={input}
        class="search"
        name="text"
        placeholder={ph}
        autocomplete="off"
      />
      {button && <button class="btn" type="submit">{button}</button>}
    </form>
  );
}

function Notes(
  { kind, items, onAdd }: {
    kind: "decisions" | "log";
    items: NoteLine[];
    onAdd: (v: string) => Promise<void>;
  },
) {
  return (
    <section class="ts-sec">
      <h4>
        {t(kind === "log" ? "ts.log" : "ts.decisions")}
        {items.length > 0 && <span class="sub">{items.length}</span>}
      </h4>
      <ul class="ts-log">
        {items.map((n, i) => (
          <li key={i}>
            {n.day && <small>{dayLabel(n.day)}</small>}
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
      <AddRow
        ph={kind === "log" ? t("ts.logPh") : t("ts.decPh")}
        onAdd={onAdd}
      />
    </section>
  );
}

function Sheet({ id, first }: { id: string; first: Item }) {
  const [data, setData] = useState(first);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const cur = useRef(data); // the latest version, for the queued jobs
  const draft = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = <T,>(job: () => Promise<T>): Promise<T> => {
    const p = queue.current.then(job, job);
    queue.current = p;
    return p;
  };
  const put = (d: Item) => {
    cur.current = d;
    setData(d);
  };
  const wrote = (r: Item) => {
    put(r);
    refreshBoard().catch(() => {});
  };

  // follows a chat's changes; its own writes are queued, so a read never lands before them
  const firstLoad = useRef(true);
  useTopic(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    void enqueue(async () => {
      const d = await loadItem(id).catch(() => null);
      if (d) put(d);
    });
  }, ["tasks"]);

  const x = data.task, p = data.progress;
  const folder = board.value?.tasks.find((y) => y.id === x.id)?.folder ?? null;
  const { desc } = splitNotes(x.notes);
  const L = data.links ??
    { parent: null, parts: [], blocked_by: [], blocking: [] };
  const linked = L.parent || L.parts.length || L.blocked_by.length ||
    L.blocking.length;
  const stages = [
    ...new Set((board.value?.tasks ?? []).map((y) => y.stage).filter(Boolean)),
  ].sort() as string[];

  const save = (input: Record<string, unknown>) =>
    enqueue(async () => {
      const r = await taskOp({
        op: "update",
        id,
        base: cur.current.task.updated,
        ...input,
      }, put);
      if (r) wrote(r);
    });
  const saveField: Save = (name, raw) => {
    const v = raw.trim();
    if (name === "title" && !v) return Promise.resolve(); // an empty title goes back to the saved one
    const input: Record<string, unknown> = {
      [name]: v === ""
        ? null
        : name === "priority" || name === "remind"
        ? Number(v)
        : name === "labels" || name === "blocked_by"
        ? list(v)
        : v,
    };
    // a time needs a day: the page's own date field decides it, today when empty
    if (name === "time" && v && !cur.current.task.due) {
      input.due = board.value?.today;
    }
    return save(input);
  };

  // The description saves itself a moment after typing stops, on leaving the field, on Esc and on closing.
  const saveDesc = (): Promise<void> => {
    clearTimeout(timer.current);
    const next = draft.current?.trim();
    if (next === undefined) return Promise.resolve();
    return enqueue(async () => {
      const { desc: saved, rest } = splitNotes(cur.current.task.notes);
      if (next !== saved) {
        const r = await taskOp({
          op: "update",
          id,
          base: cur.current.task.updated,
          notes: [next, rest].filter(Boolean).join("\n\n") || null,
        }, put);
        if (r) {
          cur.current = r;
          setData(r);
          refreshBoard().catch(() => {});
        }
      }
      if (draft.current === next) {
        draft.current = null;
        setDescDraft(null);
      }
    });
  };
  const saveDescRef = useRef(saveDesc);
  saveDescRef.current = saveDesc;
  const typing = (v: string) => {
    draft.current = v;
    setDescDraft(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveDescRef.current(), 900);
  };

  useEffect(() => {
    // Esc closes the drawer by removing it, and a removed field gets no blur: save first
    const onEsc = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        document.activeElement?.matches("textarea[name=desc]")
      ) void saveDescRef.current();
    };
    document.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("keydown", onEsc, true);
      void saveDescRef.current();
    };
  }, []);

  const op = async (body: Parameters<typeof taskOp>[0]) => {
    const r = await enqueue(() => taskOp(body, put));
    if (r) wrote(r);
    return r;
  };

  const upload = async (files: File[]) => {
    if (!files.length) return;
    toast(t("ts.uploading", { n: files.length }));
    let last: Item | null = null;
    for (const f of files) {
      const r = await uploadFile(id, f);
      if (!r.ok) toast(`${f.name}: ${r.message ?? ""}`, true);
      else last = r;
    }
    if (last) wrote(last);
  };

  useEffect(() => {
    if (mode === "edit") area.current?.focus();
  }, [mode]);

  const setDescMode = (m: "view" | "edit") => {
    if (m === "view") void saveDescRef.current();
    setMode(m);
  };

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setOver(true);
      }
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) {
        setOver(false);
      }
    },
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      setOver(false);
      void upload([...e.dataTransfer.files]);
    },
  };

  const f = (name: string, value: string | number | undefined | null) => ({
    name,
    value: String(value ?? ""),
    onSave: saveField,
  });
  const opt = (v: string | number, l: string) => (
    <option key={v} value={String(v)}>{l}</option>
  );

  return (
    <div class="tsheet" {...dropProps}>
      <div class="ts-crumb">
        {folder
          ? (
            <>
              <Ico kind="path" />
              <span>{folder.split("/").join(" › ")}</span>
              <button
                type="button"
                class="btn sm"
                onClick={() => openPath(`~/${folder}`)}
              >
                {t("ts.openFolder")}
              </button>
            </>
          )
          : <span class="sub">{x.project ?? t("tb.noProject")}</span>}
        {x.detail && (
          <button
            type="button"
            class="btn sm"
            title={x.detail}
            onClick={() => openAttachment(detailTarget(x.detail!, folder))}
          >
            {t("ts.openDetail")}
          </button>
        )}
      </div>
      <Field
        {...f("title", x.title)}
        class="ts-title"
        aria-label={t("tb.h.title")}
      />
      <div class="ts-props">
        <Prop label={t("ts.status")}>
          <Field {...f("status", x.status)} select>
            {[...COLS, "dropped"].map((s) => opt(s, tk(`tb.col.${s}`)))}
          </Field>
        </Prop>
        <Prop label={t("ts.due")}>
          <Field {...f("due", x.due)} type="date" />
        </Prop>
        <Prop label={t("ts.time")}>
          <Field {...f("time", x.time)} type="time" />
        </Prop>
        <Prop label={t("ts.priority")}>
          <Field {...f("priority", x.priority ?? 2)} select>
            {[1, 2, 3].map((n) => opt(n, tk(`ts.p${n}`)))}
          </Field>
        </Prop>
        <Prop label={t("ts.owner")}>
          <Field {...f("owner", x.owner ?? owner.value.id)} list="ts-owners" />
        </Prop>
        <Prop label={t("ts.project")} wide>
          <Field {...f("project", x.project)} list="ts-projects" />
        </Prop>
        <Prop label={t("ts.repeat")}>
          <Field {...f("repeat", x.repeat)} select>
            {opt("", t("ts.r.none"))}
            {["daily", "weekdays", "weekly", "monthly"].map((r) =>
              opt(r, tk(`ts.r.${r}`))
            )}
          </Field>
        </Prop>
        <Prop label={t("ts.remind")}>
          <Field
            {...f("remind", x.remind)}
            type="number"
            min="0"
            max="1440"
            placeholder="15"
          />
        </Prop>
        <Prop label={t("ts.ref")}>
          <Field {...f("ref", x.ref)} placeholder="TASK-1" />
        </Prop>
        <Prop label={t("ts.stage")}>
          <Field {...f("stage", x.stage)} list="ts-stages" />
        </Prop>
        <Prop label={t("ts.labels")} wide>
          <Field {...f("labels", (x.labels ?? []).join(", "))} />
        </Prop>
        <Prop label={t("ts.parent")}>
          <Field
            {...f("parent", L.parent ? refOf(L.parent) : x.parent)}
            placeholder={t("ts.refPh")}
          />
        </Prop>
        <Prop label={t("ts.blockedBy")}>
          <Field
            {...f("blocked_by", L.blocked_by.map(refOf).join(", "))}
            placeholder={t("ts.refsPh")}
          />
        </Prop>
        <Prop label={t("ts.detail")} wide>
          <Field {...f("detail", x.detail)} placeholder={t("ts.detailPh")} />
        </Prop>
        <datalist id="ts-stages">
          {stages.map((s) => <option key={s} value={s} />)}
        </datalist>
        <datalist id="ts-owners">
          {[owner.value.id, "claude"].map((o) => <option key={o} value={o} />)}
        </datalist>
        <datalist id="ts-projects">
          {(board.value?.projects ?? []).map((n) => (
            <option key={n.path} value={n.path} />
          ))}
        </datalist>
      </div>

      <section class="ts-sec">
        <h4>
          {t("ts.steps")}
          {p && <span class="sub">{p.done}/{p.total} · {p.pct}%</span>}
        </h4>
        {p && (
          <div class="ts-bar">
            <i style={{ width: `${p.pct}%` }} />
          </div>
        )}
        <div class="ts-steps">
          {data.steps.map((s, i) => (
            <label key={i} class={`ts-step${s.done ? " done" : ""}`}>
              <input
                type="checkbox"
                checked={s.done}
                onChange={async (e) => {
                  const done = e.currentTarget.checked;
                  const r = await op({ op: "step", id, index: i, done });
                  if (!r) {
                    setData({ ...cur.current }); // refused: the box goes back
                  }
                }}
              />
              <span>{s.text}</span>
            </label>
          ))}
        </div>
        <AddRow
          ph={t("ts.addStep")}
          onAdd={async (text) => void await op({ op: "addstep", id, text })}
        />
      </section>

      {linked
        ? (
          <section class="ts-sec">
            <h4>{t("ts.links")}</h4>
            {L.parent && (
              <>
                <h5>{t("ts.parent")}</h5>
                <Links items={[L.parent]} />
              </>
            )}
            {L.parts.length > 0 && (
              <>
                <h5>
                  {t("ts.parts")}{" "}
                  <span class="sub">
                    {L.parts.filter((l) => !isOpen(l)).length}/{L.parts.length}
                  </span>
                </h5>
                <Links items={L.parts} />
              </>
            )}
            {L.blocked_by.length > 0 && (
              <>
                <h5>{t("ts.blockedBy")}</h5>
                <Links items={L.blocked_by} />
              </>
            )}
            {L.blocking.length > 0 && (
              <>
                <h5>{t("ts.blocking")}</h5>
                <Links items={L.blocking} />
              </>
            )}
          </section>
        )
        : null}

      <section class="ts-sec">
        <h4>
          {t("ts.desc")}
          <span class="seg sm">
            <button
              type="button"
              aria-pressed={mode === "view"}
              onClick={() => setDescMode("view")}
            >
              {t("ts.preview")}
            </button>
            <button
              type="button"
              aria-pressed={mode === "edit"}
              onClick={() => setDescMode("edit")}
            >
              {t("ts.edit")}
            </button>
          </span>
        </h4>
        {mode === "edit"
          ? (
            <textarea
              class="ts-desc search"
              name="desc"
              rows={8}
              placeholder={t("ts.descPh")}
              value={descDraft ?? desc}
              ref={area}
              onInput={(e) => typing(e.currentTarget.value)}
              onBlur={() => void saveDesc()}
            />
          )
          : (
            <div
              class="md ts-md"
              onClick={(e) => {
                // a [[wiki page]] or a web link in the description opens, it does not edit
                if ((e.target as Element).closest("a")) return;
                setMode("edit");
              }}
            >
              {desc
                ? renderMarkdown(
                  desc,
                  (target) =>
                    openAttachment({ kind: "page", target, label: target }),
                )
                : <p class="sub">{t("ts.descPh")}</p>}
            </div>
          )}
      </section>

      <Notes
        kind="decisions"
        items={data.decisions ?? []}
        onAdd={async (text) =>
          void await op({ op: "note", id, section: "decisions", text })}
      />
      <Notes
        kind="log"
        items={data.log ?? []}
        onAdd={async (text) =>
          void await op({ op: "note", id, section: "log", text })}
      />

      <section class="ts-sec">
        <h4>{t("ts.att")}</h4>
        <ul class="ts-att">
          {data.attachments.map((a, i) => (
            <li key={i}>
              <Ico kind={a.kind} />
              <button
                type="button"
                class="ts-a"
                title={a.target}
                onClick={() => openAttachment(a)}
              >
                <b>{a.label}</b>
                <small>{a.target}</small>
              </button>
              <button
                type="button"
                class="x"
                aria-label={t("ts.remove")}
                title={t("ts.remove")}
                onClick={() => void op({ op: "detach", id, index: i })}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <AddRow
          ph={t("ts.attPh")}
          button={t("mk.add")}
          onAdd={async (target) => void await op({ op: "attach", id, target })}
        />
        <label class={`ts-drop${over ? " over" : ""}`}>
          <input
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              void upload(files);
            }}
          />
          <svg viewBox="0 0 24 24" class="ico">
            <path d="M12 16V4M7 9l5-5 5 5" />
            <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
          </svg>
          <span>{t("ts.drop")}</span>
        </label>
      </section>

      <footer class="ts-foot">
        <span class="sub">
          {t("ts.created", { a: ago(x.created), b: ago(x.updated) })} ·{" "}
          <code>{x.id}</code>
        </span>
        <span class="r" />
        {x.status === "done"
          ? (
            <button
              type="button"
              class="btn"
              onClick={() => save({ status: "todo" })}
            >
              {t("ts.reopen")}
            </button>
          )
          : (
            <>
              <button
                type="button"
                class="btn"
                onClick={() => save({ status: "dropped" })}
              >
                {t("ts.drop2")}
              </button>
              <button
                type="button"
                class="btn primary"
                onClick={() => save({ status: "done" })}
              >
                {t("ts.done")}
              </button>
            </>
          )}
      </footer>
    </div>
  );
}
