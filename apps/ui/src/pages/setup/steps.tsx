// steps.tsx — the first-run wizard's first steps: welcome and language, you, the configuration folder,
// the profiles, install. Each sends its answer to its endpoint and moves on when the server took it;
// a refusal stays on the step, its reason under the fields.

import { Fragment } from "preact";
import { useRef, useState } from "preact/hooks";
import { lang, setLangPref, t } from "../../i18n.ts";
import { runJob } from "../../lib/ui.tsx";
import { StepRows } from "../../lib/steps.tsx";
import { post } from "../../api.ts";
import { send } from "./api.ts";
import { Nav, type StepProps } from "./index.tsx";

/** A step's write: busy while it runs, its refusal kept to show, `then` on success. */
export function useSend(p: StepProps) {
  const [cause, setCause] = useState("");
  const [running, setRunning] = useState(false);
  const run = async <T extends { ok: boolean; message?: string }>(work: () => Promise<T>, then?: (r: T) => unknown) => {
    setRunning(true);
    p.busy(true);
    setCause("");
    const r = await work();
    setRunning(false);
    p.busy(false);
    if (!r.ok) return setCause(r.message ?? "");
    await (then ? then(r) : p.next());
  };
  return { cause, running, run };
}

export function Welcome(p: StepProps) {
  const s = useSend(p);
  const l = lang();
  return (
    <>
      <h2>{t("su.welcome.h")}</h2>
      <ul class="su-points">
        <li>{t("su.welcome.1")}</li>
        <li>{t("su.welcome.2")}</li>
        <li>{t("su.welcome.3")}</li>
      </ul>
      <div class="su-lang" role="radiogroup" aria-label={t("su.welcome.lang")}>
        <span>{t("su.welcome.lang")}</span>
        {[["it", "Italiano"], ["en", "English"]].map(([code, name]) => (
          <button
            key={code}
            type="button"
            role="radio"
            aria-checked={l === code}
            class={`chip pick${l === code ? " on" : ""}`}
            onClick={() => setLangPref(code)}
          >
            {name}
          </button>
        ))}
      </div>
      {s.cause && <p class="uw-cause">{s.cause}</p>}
      <Nav back={null}>
        <button type="button" class="bt pri" disabled={s.running} onClick={() => void s.run(() => send("pass", { step: "welcome" }))}>
          {t("su.welcome.go")}
        </button>
      </Nav>
    </>
  );
}

export function You(p: StepProps) {
  const s = useSend(p);
  const o = p.v.facts.owner ?? p.v.facts.record?.owner;
  const [name, setName] = useState(o?.name && o.name !== "Your name" ? o.name : "");
  const [language, setLanguage] = useState(o?.language || t("su.you.langDefault"));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void s.run(() => send("owner", { name, language }));
      }}
    >
      <h2>{t("su.you.h")}</h2>
      <p class="su-sub">{t("su.you.sub")}</p>
      <label class="fld">
        {t("su.you.name")}
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} required autofocus autocomplete="name" />
      </label>
      <label class="fld">
        {t("su.you.lang")}
        <input value={language} onInput={(e) => setLanguage(e.currentTarget.value)} required list="su-langs" />
        <datalist id="su-langs">
          <option value="Italiano" />
          <option value="English" />
        </datalist>
      </label>
      {s.cause && <p class="uw-cause">{s.cause}</p>}
      <Nav back={p.back}>
        <button type="submit" class="bt pri" disabled={s.running || !name.trim()}>{t("su.next")}</button>
      </Nav>
    </form>
  );
}

export function Folder(p: StepProps) {
  const s = useSend(p);
  const f = p.v.facts;
  const [folder, setFolder] = useState(f.folder ?? p.v.suggested);
  const [linked, setLinked] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void s.run(() => send<{ ok: boolean; message?: string; existing?: boolean }>("folder", { folder }), async (r) => {
          // another machine's configuration, only linked: say so before moving on
          if (r.existing && !linked) return setLinked(folder);
          await p.next();
        });
      }}
    >
      <h2>{t("su.folder.h")}</h2>
      <p class="su-sub">{t("su.folder.sub")}</p>
      <label class="fld">
        {t("su.folder.field")}
        <input class="mono" value={folder} onInput={(e) => setFolder(e.currentTarget.value)} required spellcheck={false} autofocus />
      </label>
      <p class="su-note">{t("su.folder.note")}</p>
      {f.folder && !linked && <p class="su-sub">{t("su.folder.current", { f: f.folder })}</p>}
      {linked && <p class="su-ok">{t("su.folder.linked", { f: linked })}</p>}
      {s.cause && <p class="uw-cause">{s.cause}</p>}
      <Nav back={p.back}>
        {linked
          ? <button type="button" class="bt pri" onClick={() => void p.next()}>{t("su.next")}</button>
          : <button type="submit" class="bt pri" disabled={s.running || !folder.trim()}>{t("su.next")}</button>}
      </Nav>
    </form>
  );
}

interface Row {
  name: string;
  command: string;
  installed: boolean;
  /** in the configuration already: removed from here only when the wizard made the configuration */
  declared: boolean;
  key: number;
}

export function Profiles(p: StepProps) {
  const s = useSend(p);
  const seq = useRef(0);
  const [rows, setRows] = useState<Row[]>(() =>
    p.v.facts.profiles.map((x) => ({ name: x.profile, command: x.command, installed: x.installed, declared: true, key: seq.current++ }))
  );
  const edit = (k: number, ch: Partial<Row>) => setRows(rows.map((r) => (r.key === k ? { ...r, ...ch } : r)));
  const add = () => {
    const name = rows.length ? `work${rows.length > 1 ? rows.length : ""}` : "personal";
    setRows([...rows, { name, command: rows.some((r) => r.command === "claude") ? `claude-${name}` : "claude", installed: false, declared: false, key: seq.current++ }]);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void s.run(() => send("profiles", { profiles: rows.map(({ name, command }) => ({ name: name.trim(), command: command.trim() })) }));
      }}
    >
      <h2>{t("su.profiles.h")}</h2>
      <p class="su-sub">{t("su.profiles.sub")}</p>
      <div class="su-profiles">
        <span class="su-th">{t("su.profiles.name")}</span>
        <span class="su-th">{t("su.profiles.command")}</span>
        <span />
        {rows.map((r) => (
          <Fragment key={r.key}>
            <input
              aria-label={t("su.profiles.name")}
              value={r.name}
              disabled={r.installed || (r.declared && !p.v.facts.record?.created)}
              required
              pattern={"[a-z][a-z0-9_\\-]{1,30}"}
              spellcheck={false}
              onInput={(e) => {
                const name = e.currentTarget.value;
                // a command still following the name keeps following it
                edit(r.key, { name, ...(r.command === `claude-${r.name}` ? { command: `claude-${name}` } : {}) });
              }}
            />
            <input
              class="mono"
              aria-label={t("su.profiles.command")}
              value={r.command}
              disabled={r.installed}
              required
              pattern={"[a-z][a-z0-9_\\-]{0,40}"}
              spellcheck={false}
              onInput={(e) => edit(r.key, { command: e.currentTarget.value })}
            />
            <button
              type="button"
              class="ib"
              title={t("su.profiles.remove", { p: r.name })}
              aria-label={t("su.profiles.remove", { p: r.name })}
              disabled={r.installed || rows.length < 2 || (r.declared && !p.v.facts.record?.created)}
              onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
            >
              <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </Fragment>
        ))}
      </div>
      <button type="button" class="bt ghost sm su-add" onClick={add} disabled={rows.length >= 8}>+ {t("su.profiles.add")}</button>
      <p class="su-note">{t("su.profiles.note")}</p>
      {s.cause && <p class="uw-cause">{s.cause}</p>}
      <Nav back={p.back}>
        <button type="submit" class="bt pri" disabled={s.running || !rows.length}>{t("su.next")}</button>
      </Nav>
    </form>
  );
}

const lastLine = (out: string) => out.trim().split("\n").filter(Boolean).pop() ?? "";

export function Install(p: StepProps) {
  const [st, setSt] = useState<"todo" | "running" | "done" | "failed">(p.v.facts.installed ? "done" : "todo");
  const [out, setOut] = useState("");
  const [cause, setCause] = useState("");
  const [showOut, setShowOut] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const go = async () => {
    setSt("running");
    setCause("");
    setOut("");
    p.busy(true);
    let text = "";
    const r = await runJob(p.v.install, undefined, (o) => setOut(text += o), setJobId).catch((e: Error) => ({ error: e.message }));
    setJobId(null);
    p.busy(false);
    if ("error" in r) return (setSt("failed"), setCause(r.error === "lost" ? t("rep.lost") : r.error));
    if (r.cancelled) return (setSt("failed"), setCause(t("uw.cancelled")));
    if (r.code) return (setSt("failed"), setCause(lastLine(text) || t("uw.exit", { c: r.code })));
    setSt("done");
    await p.next();
  };
  return (
    <>
      <h2>{t("su.install.h")}</h2>
      <p class="su-sub">{t("su.install.sub")}</p>
      {st !== "todo" && <StepRows rows={[{ key: "install", label: t("su.install.row"), state: st }]} />}
      {cause && <p class="uw-cause">{cause}</p>}
      <Nav back={st === "running" ? null : p.back}>
        {out && (
          <button type="button" class="bt ghost" onClick={() => setShowOut(!showOut)}>
            {t(showOut ? "su.install.hideOut" : "su.install.showOut")}
          </button>
        )}
        {st === "running"
          ? (
            <button type="button" class="bt" onClick={() => jobId && void post("/api/job/cancel", { id: jobId }).catch(() => {})}>
              {t("uw.cancel")}
            </button>
          )
          : st === "done"
          ? <button type="button" class="bt pri" onClick={() => void p.next()}>{t("su.next")}</button>
          : <button type="button" class="bt pri" onClick={() => void go()}>{t(st === "failed" ? "su.retry" : "su.install.go")}</button>}
      </Nav>
      {out && showOut && <pre class="out uw-out">{out}</pre>}
    </>
  );
}
