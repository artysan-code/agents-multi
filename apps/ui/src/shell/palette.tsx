// palette.tsx — Ctrl K: the views and the commands, searched by name. A command that belongs to a page
// (a new task, a new profile, the update wizard) is a request the page takes (router.ts, intents).

import { signal } from "@preact/signals";
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { type Key, t } from "../i18n.ts";
import { runAction } from "../lib/ui.tsx";
import { go, request, TABS } from "../router.ts";
import { cycleLang, cycleTheme } from "./prefs.ts";

export const paletteOpen = signal(false);

interface Cmd {
  s: Key;
  n: string;
  d: string;
  f: () => void;
}

const cmds = (): Cmd[] => [
  { s: "pal.goto", n: t("nav.today"), d: "today", f: () => go("today") },
  { s: "pal.goto", n: t("nav.tasks"), d: "tasks", f: () => go("tasks") },
  {
    s: "pal.do",
    n: t("tb.new"),
    d: "task",
    f: () => request("tasks.new", "tasks"),
  },
  { s: "pal.goto", n: t("nav.brain"), d: "brain", f: () => go("brain") },
  {
    s: "pal.goto",
    n: t("nav.connections"),
    d: "connections",
    f: () => go("connections"),
  },
  ...TABS.map((x): Cmd => ({
    s: "pal.goto",
    n: `${t("nav.system")} · ${t(`sys.${x}`)}`,
    d: `system/${x}`,
    f: () => go(`system/${x}`),
  })),
  {
    s: "pal.run",
    n: t("cmd.health"),
    d: "doctor",
    f: () => request("health.rerun", "system/health"),
  },
  {
    s: "pal.run",
    n: t("cmd.mcpSync"),
    d: "mcp sync",
    f: () => runAction("mcp-sync"),
  },
  {
    s: "pal.run",
    n: t("cmd.mcpCheck"),
    d: "mcp check",
    f: () => runAction("mcp-check"),
  },
  {
    s: "pal.run",
    n: t("cmd.fetch"),
    d: "sync --fetch",
    f: () => runAction("sync-fetch"),
  },
  {
    s: "pal.run",
    n: t("cmd.installDry"),
    d: "install --dry-run",
    f: () => runAction("install-dry"),
  },
  {
    s: "pal.run",
    n: t("cmd.install"),
    d: "install",
    f: () => runAction("install"),
  },
  {
    s: "pal.run",
    n: t("cmd.updateCheck"),
    d: "update --check",
    f: () => runAction("update-check"),
  },
  {
    s: "pal.run",
    n: t("cmd.updateNow"),
    d: "update --auto",
    f: () => request("update.wizard"),
  },
  {
    s: "pal.do",
    n: t("cmd.addProfile"),
    d: "new",
    f: () => request("profiles.new", "system/profiles"),
  },
  { s: "pal.do", n: t("cmd.theme"), d: "theme", f: cycleTheme },
  { s: "pal.do", n: t("cmd.lang"), d: "language", f: cycleLang },
];

function Palette() {
  const all = cmds();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ql = q.toLowerCase().trim();
  const hits = ql
    ? all.filter((c) => `${c.n} ${c.d} ${t(c.s)}`.toLowerCase().includes(ql))
    : all;

  useEffect(() => input.current?.focus(), []);
  useEffect(
    () =>
      list.current?.querySelector(`[data-sel="1"]`)?.scrollIntoView({
        block: "nearest",
      }),
    [sel, q],
  );

  const run = (c: Cmd | undefined) => {
    if (!c) return;
    paletteOpen.value = false;
    c.f();
  };

  let lastSec = "";
  return (
    <div
      class="pal-wrap"
      onClick={(e) =>
        e.target === e.currentTarget && (paletteOpen.value = false)}
    >
      <div class="pal">
        <input
          ref={input}
          placeholder={t("pal.ph")}
          aria-label={t("pal.ph")}
          value={q}
          onInput={(e) => {
            setQ(e.currentTarget.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              setSel(Math.min(sel + 1, hits.length - 1));
              e.preventDefault();
            } else if (e.key === "ArrowUp") {
              setSel(Math.max(sel - 1, 0));
              e.preventDefault();
            } else if (e.key === "Enter") run(hits[sel]);
            else if (e.key === "Escape") paletteOpen.value = false;
          }}
        />
        <div class="pal-list" ref={list}>
          {hits.length
            ? hits.map((c, i) => {
              const head = c.s !== lastSec
                ? <div class="pal-sec">{t(c.s)}</div>
                : null;
              lastSec = c.s;
              return (
                <Fragment key={c.d}>
                  {head}
                  <div
                    class="pal-i"
                    data-sel={i === sel ? 1 : 0}
                    onClick={() => run(c)}
                  >
                    <svg viewBox="0 0 24 24">
                      {c.s === "pal.goto"
                        ? <path d="M5 12h14M13 6l6 6-6 6" />
                        : (
                          <>
                            <path d="M8 6l6 6-6 6" />
                            <path d="M15 18h4" />
                          </>
                        )}
                    </svg>
                    {c.n}
                    <span class="d">{c.d}</span>
                  </div>
                </Fragment>
              );
            })
            : <div class="pal-sec">{t("pal.none")}</div>}
        </div>
      </div>
    </div>
  );
}

export function PaletteHost() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        paletteOpen.value = !paletteOpen.value;
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  return paletteOpen.value ? <Palette /> : null;
}
