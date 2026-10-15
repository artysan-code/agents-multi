// limits/index.tsx — Accounts & limits: one card per profile, the account it is signed in as, its usage
// limits (the five hours and the week, with when each starts again), today's tokens and how old the
// reading is, and its Claude Desktop (a click opens it or brings it forward). The limits come from the
// status line at each turn (apps/cli/live.ts); «Ask now» asks Anthropic for them with each profile's
// own login, only when the person asks.

import { useState } from "preact/hooks";
import type { Result } from "../../api.ts";
import { lang, t } from "../../i18n.ts";
import { ago } from "../../lib/format.ts";
import { useThrottled } from "../../lib/throttle.ts";
import { pcolor, toast } from "../../lib/ui.tsx";
import { status, useTopic } from "../../state.ts";
import { type Limit, loadLive, type LiveView, openDesktop, refreshLive } from "./api.ts";
import "./limits.css";

/** Tokens as a person reads them: 950, 12k, 3.4M. */
const tokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** When a window starts again: the hour today, else the day and the hour. */
function resetsAt(sec: number | null): string {
  if (!sec) return "";
  const d = new Date(sec * 1000), now = new Date();
  const hm = d.toLocaleTimeString(lang(), { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === now.toDateString() ? hm : `${d.toLocaleDateString(lang(), { weekday: "short" })} ${hm}`;
}

export const level = (pct: number) => (pct >= 80 ? "crit" : pct >= 50 ? "warn" : "ok");

function LimitBar({ label, l }: { label: string; l?: Limit }) {
  if (!l) return null;
  const pct = Math.max(0, Math.min(100, l.used));
  return (
    <div class={`lim ${level(l.used)}`}>
      <span class="lim-l">{label}</span>
      <span class="lim-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <b>{Math.round(l.used)}%</b>
      <small>{l.resets ? t("now.resets", { w: resetsAt(l.resets) }) : ""}</small>
    </div>
  );
}

async function say(p: Promise<Result>): Promise<void> {
  const r = await p.catch((e: Error): Result => ({ ok: false, message: e.message }));
  if (!r.ok) toast(r.message ?? "", true);
}

export function Limits() {
  const s = status.value;
  const profiles = Object.keys(s?.profiles ?? {});
  const open = new Set(s?.running.desktop.map((d) => d.variant) ?? []);
  const [view, setView] = useState<LiveView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // the status line writes at every turn: read again at most every 15 s, the last change included
  const load = useThrottled(async () => {
    const v = await loadLive().catch(() => null);
    if (v) setView(v);
  }, 15000);
  useTopic(load, ["state", "usage"]);

  const refresh = async () => {
    setRefreshing(true);
    const v = await refreshLive().catch((e: Error) => {
      toast(e.message, true);
      return null;
    });
    setRefreshing(false);
    if (!v) return;
    setView(v);
    const errs = Object.entries(v.errors ?? {});
    if (errs.length) toast(errs.map(([p, e]) => `${p}: ${e}`).join(" · "), true);
  };

  return (
    <>
      <header class="pg-hr">
        <h1 class="pg-h">{t("nav.limits")}</h1>
        <button type="button" class={`bt sm ghost lm-rf${refreshing ? " on" : ""}`} onClick={() => void refresh()}>
          <svg viewBox="0 0 16 16">
            <path d="M13 8a5 5 0 1 1-1.5-3.5M13 3v3h-3" />
          </svg>
          {t("now.refresh")}
        </button>
      </header>
      <p class="sub lm-sub">{t("lm.sub")}</p>
      <div class="lm-grid">
        {profiles.map((p) => {
          const v = view?.profiles[p];
          const on = open.has(p);
          const account = s?.profiles[p]?.account;
          return (
            <article class="card lm" key={p} style={{ "--k": pcolor(p) }}>
              <div class="lm-h">
                <i class="dot2" />
                <b>{p}</b>
                <span class="hd-sp" />
                <button
                  type="button"
                  class={`lm-dk${on ? " on" : ""}`}
                  title={t(on ? "run.focus" : "run.open")}
                  aria-label={t(on ? "run.focus" : "run.open")}
                  onClick={() => void say(openDesktop(p))}
                >
                  <svg viewBox="0 0 16 16">
                    <rect x="2" y="3" width="12" height="9" rx="1.5" />
                    <path d="M6 14h4" />
                  </svg>
                </button>
              </div>
              <div class="lm-acc">{account ?? t("lm.noAccount")}</div>
              {v?.limits
                ? (
                  <>
                    <LimitBar label={t("now.5h")} l={v.limits.five_hour} />
                    <LimitBar label={t("now.7d")} l={v.limits.seven_day} />
                  </>
                )
                : <small class="lm-none">{t("now.noLimits")}</small>}
              <div class="lm-f">
                {!!v?.tokens && <span>{t("now.tokens", { n: tokens(v.tokens) })}</span>}
                <span class="hd-sp" />
                {v?.at && <span>{t("lm.read", { d: ago(new Date(v.at * 1000).toISOString()) })}</span>}
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}
