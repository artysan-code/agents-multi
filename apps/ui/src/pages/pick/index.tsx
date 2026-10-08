// index.tsx — «Which Claude?», the profile picker: one row per profile with its colour (the same as on
// Today), its account, «default» for the machine's plain `claude`, and its state: sessions running,
// Desktop open, sign-in expired, or closed. A line says what choosing it will do; at the foot, the
// day's next appointment. The desktop app shows it at /#pick in a small window of its own, without the
// console's frame; choosing a profile asks the console to run claude-launch, which starts that Desktop
// or brings its window forward. The report adds, when it comes, the accounts and the states: without
// it the names are enough.
//
// Keys: ↑ ↓ (or Tab) to move, 1–9 or Enter to open, Esc to close. The window closes itself when it loses
// the focus (the app does that); the page asks for it to close after a choice and on Esc.

import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n.ts";
import { machineLang } from "../../state.ts";
import { closeWindow as close } from "../../lib/window.ts";
import { profileColor } from "../../lib/pcolor.ts";
import type { DayItem } from "../today/api.ts";
import { countdown, upNext } from "../today/model.ts";
import { type Launcher, pickApi, type PickStatus } from "./api.ts";
import "./pick.css";
import { Mark } from "../../shell/mark.tsx";

const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);
/** The checks that say a profile's sign-in no longer works (doctor: logins, profiles). */
const expired = (s: PickStatus | null, p: string) =>
  !!s?.doctor.some((c) =>
    c.status !== "ok" &&
    (c.id === `login.${p}` || c.id === `profile.${p}.login` ||
      c.id === `profile.${p}.creds`)
  );

const SPK = (
  <svg viewBox="0 0 14 14">
    <path d="M7 1.5v11M1.5 7h11M3.1 3.1l7.8 7.8M10.9 3.1l-7.8 7.8" />
  </svg>
);

function Next({ x }: { x: DayItem }) {
  const now = new Date();
  const cd = countdown(
    now.getHours() * 60 + now.getMinutes(),
    Number(x.time!.slice(0, 2)) * 60 + Number(x.time!.slice(3, 5)),
  );
  const when = cd.unit === "min"
    ? `${cd.n} min`
    : cd.rest
    ? `${cd.n} h ${cd.rest}`
    : `${cd.n} h`;
  return (
    <div class="pick-next">
      <i style={{ background: x.color ?? "var(--accent)" }} />
      <span>
        {t("pick.next")} <b>{when}</b> · {x.title}
      </span>
    </div>
  );
}

export function Pick() {
  const [profiles, setProfiles] = useState<Launcher[] | null>(null);
  const [status, setStatus] = useState<PickStatus | null>(null);
  const [next, setNext] = useState<DayItem | null>(null);
  const [current, setCurrent] = useState(0);
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);
  // the window is as tall as the rows need (picker.rs): what does not fit goes, the keys first
  const [room, setRoom] = useState(2);
  const main = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = main.current;
    if (el && room > 0 && el.scrollHeight > innerHeight + 1) setRoom(room - 1);
  });
  useEffect(() => {
    const grow = () => setRoom(2);
    addEventListener("resize", grow);
    return () => removeEventListener("resize", grow);
  }, []);

  useEffect(() => {
    document.title = t("pick.title");
    pickApi.launchers().then(({ profiles: ps }) => {
      setProfiles(ps);
      setCurrent(Math.max(0, ps.findIndex((l) => l.command === "claude")));
    }).catch((e: Error) => setNote({ text: e.message, err: true }));
    pickApi.status().then((s) => {
      setStatus(s);
      machineLang.value = s.language;
    }).catch(() => {/* a nicety: the names are enough */});
    pickApi.day().then((d) => {
      const now = new Date();
      const items = [...(d.earlier ?? []), ...d.today].filter((x) =>
        x.time && x.status !== "done"
      );
      setNext(upNext(items, now.getHours() * 60 + now.getMinutes())[0] ?? null);
    }).catch(() => {/* the strip is optional */});
  }, []);

  const choose = async (p: string) => {
    setNote({ text: t("pick.opening", { p: label(p) }), err: false });
    try {
      const r = await pickApi.launch(p);
      if (!r.ok) throw new Error(r.message ?? "");
      close();
    } catch (e) {
      setNote({
        text: t("pick.failed", { p: label(p), e: (e as Error).message }),
        err: true,
      });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = profiles?.length ?? 0;
      if (e.key === "Escape") close();
      else if (!n) return;
      else if (e.key === "Enter") void choose(profiles![current].profile);
      else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
        setCurrent((current + 1) % n);
      } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
        setCurrent((current - 1 + n) % n);
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) {
        void choose(profiles![Number(e.key) - 1].profile);
      } else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [profiles, current]);

  const names = (profiles ?? []).map((l) => l.profile);
  const open = new Set(status?.running.desktop.map((d) => d.variant) ?? []);
  const cli = (p: string) =>
    status?.running.cli.filter((c) => c.profile === p).length ?? 0;
  const cur = profiles?.[current]?.profile;
  // what choosing the selected row will do
  const hint = !cur || !status
    ? t("pick.hint")
    : open.has(cur)
    ? t("pick.will.focus")
    : expired(status, cur)
    ? t("pick.will.login")
    : t("pick.will.open");
  const n = profiles?.length ?? 0;
  return (
    <main class="pick" ref={main}>
      <header>
        <Mark />
        <h1>{t("pick.title")}</h1>
        <kbd class="k2">Esc</kbd>
      </header>
      {profiles && !profiles.length && <p class="pick-note">{t("pick.none")}
      </p>}
      <ul role="listbox" aria-label={t("pick.title")}>
        {profiles?.map(({ profile, command }, i) => {
          const account = status?.profiles[profile]?.account;
          const on = open.has(profile),
            sessions = cli(profile),
            exp = expired(status, profile);
          return (
            <li
              key={profile}
              role="option"
              aria-selected={i === current}
              style={{ "--k": profileColor(profile, names) }}
              onMouseEnter={() => setCurrent(i)}
              onClick={() => void choose(profile)}
            >
              <span class={`pick-av${on ? " on" : ""}`} aria-hidden="true">
                {label(profile).charAt(0)}
              </span>
              <span class="pick-t">
                <b>
                  {label(profile)}
                  {command === "claude" && <em>{t("pick.default")}</em>}
                </b>
                {account && <small>{account}</small>}
              </span>
              <span class="pick-st">
                {sessions > 0 && (
                  <span class="run">
                    {SPK}
                    {t("pick.sessions", { n: sessions })}
                  </span>
                )}
                {sessions > 0 && (on || exp) && " · "}
                {exp
                  ? <span class="warn">{t("pick.expired")}</span>
                  : on
                  ? <span class="on">{t("pick.open")}</span>
                  : !sessions && status
                  ? t("pick.closed")
                  : ""}
              </span>
              {i < 9 ? <kbd class="k2">{i + 1}</kbd> : <span />}
            </li>
          );
        })}
      </ul>
      <p
        class={`pick-note${note?.err ? " err" : note ? " busy" : ""}`}
        role="status"
      >
        {note ? note.text : hint}
      </p>
      {next && room > 0 && <Next x={next} />}
      <footer hidden={room < 2}>
        <kbd class="k2">↑</kbd>
        <kbd class="k2">↓</kbd>
        <span>{t("pick.k.choose")}</span>
        <kbd class="k2">↵</kbd>
        <span>{t("pick.k.open")}</span>
        {n > 1 && (
          <>
            <kbd class="k2">1</kbd>–<kbd class="k2">{Math.min(n, 9)}</kbd>
            <span>{t("pick.k.direct")}</span>
          </>
        )}
      </footer>
    </main>
  );
}
