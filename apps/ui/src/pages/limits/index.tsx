// limits/index.tsx — Accounts & limits: one card per profile, the account it is signed in as and its
// Claude Desktop (a click opens it or brings it forward), then each of its accounts — Claude, and Codex
// where the profile has it — with its usage windows (when each starts again) and how old the reading is,
// «stale» past half an hour (the limits manager's rule: it does not act on such a reading), and today's
// tokens. The windows are what `agents limits` reads (/api/limits): the status line's snapshots and
// Codex's session logs; «Ask for the limits now» asks Anthropic for Claude's with each profile's own
// login, only when the person asks.

import { useState } from "preact/hooks";
import type { Result } from "../../api.ts";
import { lang, t, tk } from "../../i18n.ts";
import { ago } from "../../lib/format.ts";
import { useThrottled } from "../../lib/throttle.ts";
import { pcolor, toast } from "../../lib/ui.tsx";
import { status, useTopic } from "../../state.ts";
import {
  type AccountLimits,
  loadLimits,
  loadLive,
  type LiveView,
  openDesktop,
  refreshLive,
  type Window,
} from "./api.ts";
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

const level = (pct: number) => (pct >= 80 ? "crit" : pct >= 50 ? "warn" : "ok");

/** A window's name as a person reads it: "5 h", "week", or as the vendor names it. */
const windowLabel = (w: string) => (w === "5h" ? t("now.5h") : w === "7d" ? t("now.7d") : w);

function LimitBar({ w }: { w: Window }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent));
  return (
    <div class={`lim ${level(w.usedPercent)}${w.stale ? " stale" : ""}`}>
      <span class="lim-l">{windowLabel(w.window)}</span>
      <span class="lim-bar">
        <i style={{ width: `${pct}%` }} />
      </span>
      <b>{Math.round(w.usedPercent)}%</b>
      <small>{w.resetsAt ? t("now.resets", { w: resetsAt(w.resetsAt) }) : ""}</small>
    </div>
  );
}

/** One account of a profile: its windows, and how old its oldest reading is. */
function Account({ a, tokensToday }: { a: AccountLimits; tokensToday?: number }) {
  const ats = a.windows.map((w) => w.at).filter((x): x is number => x !== null);
  const oldest = ats.length ? Math.min(...ats) : null;
  const stale = a.windows.some((w) => w.stale);
  return (
    <div class="lm-acct">
      <div class="lm-ah">
        <span>{tk(`lm.p.${a.account.provider}`)}</span>
        <span class="hd-sp" />
        {oldest !== null && <small>{t("lm.read", { d: ago(new Date(oldest * 1000).toISOString()) })}</small>}
        {stale && <span class="lm-stale" title={t("lm.stale.hint")}>{t("lm.stale")}</span>}
      </div>
      {a.windows.length
        ? a.windows.map((w) => <LimitBar key={w.window} w={w} />)
        : <small class="lm-none">{t(a.account.provider === "codex" ? "lm.noCodex" : "now.noLimits")}</small>}
      {!!tokensToday && <div class="lm-f">{t("now.tokens", { n: tokens(tokensToday) })}</div>}
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
  const [accounts, setAccounts] = useState<AccountLimits[] | null>(null);
  const [live, setLive] = useState<LiveView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // the status line writes at every turn: read again at most every 15 s, the last change included
  const load = useThrottled(async () => {
    const [l, v] = await Promise.all([loadLimits().catch(() => null), loadLive().catch(() => null)]);
    if (l) setAccounts(l.accounts);
    if (v) setLive(v);
  }, 15000);
  useTopic(load, ["state", "usage"]);

  const refresh = async () => {
    setRefreshing(true);
    const v = await refreshLive().catch((e: Error) => {
      toast(e.message, true);
      return null;
    });
    const l = await loadLimits().catch(() => null);
    setRefreshing(false);
    if (l) setAccounts(l.accounts);
    if (!v) return;
    setLive(v);
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
          const on = open.has(p);
          const mine = accounts?.filter((a) => a.account.profile === p) ?? [];
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
              <div class="lm-acc">{s?.profiles[p]?.account ?? t("lm.noAccount")}</div>
              {mine.map((a) => (
                <Account
                  key={a.account.id}
                  a={a}
                  tokensToday={a.account.provider === "claude" ? live?.profiles[p]?.tokens : undefined}
                />
              ))}
            </article>
          );
        })}
      </div>
    </>
  );
}
