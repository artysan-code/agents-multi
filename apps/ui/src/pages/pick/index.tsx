// index.tsx — «Which Claude?», the profile picker: one row per profile, the machine's default (plain
// `claude`) selected first. The desktop app shows it at /#pick in a small window of its own, without
// the console's frame; choosing a profile asks the console to run claude-launch, which starts that
// Desktop or brings its window forward. The report adds, when it comes, the account each profile is
// signed in to and whether its Desktop is open: without it the names are enough.
//
// Keys: ↑ ↓ (or Tab) to move, 1–9 or Enter to open, Esc to close. The window closes itself when it loses
// the focus (the app does that); the page asks for it to close after a choice and on Esc.

import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n.ts";
import { machineLang } from "../../state.ts";
import { closeWindow as close } from "../../lib/window.ts";
import { type Launcher, pickApi, type PickStatus } from "./api.ts";
import "./pick.css";

const label = (p: string) => p.charAt(0).toUpperCase() + p.slice(1);

export function Pick() {
  const [profiles, setProfiles] = useState<Launcher[] | null>(null);
  const [status, setStatus] = useState<PickStatus | null>(null);
  const [current, setCurrent] = useState(0);
  const [note, setNote] = useState<{ text: string; err: boolean } | null>(null);

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
  }, []);

  const choose = async (p: string) => {
    setNote({ text: t("pick.opening", { p: label(p) }), err: false });
    try {
      const r = await pickApi.launch(p);
      if (!r.ok) throw new Error(r.message ?? "");
      close();
    } catch (e) {
      setNote({ text: t("pick.failed", { p: label(p), e: (e as Error).message }), err: true });
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const n = profiles?.length ?? 0;
      if (e.key === "Escape") close();
      else if (!n) return;
      else if (e.key === "Enter") void choose(profiles![current].profile);
      else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) setCurrent((current + 1) % n);
      else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) setCurrent((current - 1 + n) % n);
      else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) void choose(profiles![Number(e.key) - 1].profile);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [profiles, current]);

  const open = new Set(status?.running.desktop.map((d) => d.variant) ?? []);
  return (
    <main class="pick">
      <header>
        <h1>{t("pick.title")}</h1>
        <kbd>Esc</kbd>
      </header>
      {profiles && !profiles.length && <p class="pick-note">{t("pick.none")}</p>}
      <ul role="listbox" aria-label={t("pick.title")}>
        {profiles?.map(({ profile }, i) => {
          const account = status?.profiles[profile]?.account;
          return (
            <li
              key={profile}
              role="option"
              aria-selected={i === current}
              onMouseEnter={() => setCurrent(i)}
              onClick={() => void choose(profile)}
            >
              <span class="pick-av" aria-hidden="true">{label(profile).charAt(0)}</span>
              <span class="pick-t">
                <b>{label(profile)}</b>
                {account && <small>{account}</small>}
              </span>
              {open.has(profile) && <span class="pick-open">{t("pick.open")}</span>}
              {i < 9 && <kbd>{i + 1}</kbd>}
            </li>
          );
        })}
      </ul>
      {note
        ? <p class={`pick-note${note.err ? " err" : ""}`} role="status">{note.text}</p>
        : <p class="pick-note">{t("pick.hint")}</p>}
    </main>
  );
}
