// format.ts — numbers, times and names as the pages show them.

import { lang } from "../i18n.ts";

/** 1234 → "1k", 2.5e6 → "2.5M"; null → "—". */
export const fmt = (n: number | null | undefined): string =>
  n == null
    ? "—"
    : n >= 1e9
    ? (n / 1e9).toFixed(2) + "G"
    : n >= 1e6
    ? (n / 1e6).toFixed(1) + "M"
    : n >= 1e3
    ? (n / 1e3).toFixed(0) + "k"
    : String(Math.round(n));

export const short = (s: unknown, n = 60): string => {
  const x = String(s ?? "");
  return x.length > n ? x.slice(0, n - 1) + "…" : x;
};

/** "3 hours ago", in the interface language. */
export const ago = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const s = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang(), { numeric: "auto" });
  const a = Math.abs(s);
  if (a < 90) return rtf.format(Math.round(s), "second");
  if (a < 5400) return rtf.format(Math.round(s / 60), "minute");
  if (a < 172800) return rtf.format(Math.round(s / 3600), "hour");
  return rtf.format(Math.round(s / 86400), "day");
};

/** A compact duration ("40s", "12m", "3h"): the same in every language. */
export const dur = (iso: string): string => {
  const s = Math.max(1, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 90
    ? `${Math.round(s)}s`
    : s < 5400
    ? `${Math.round(s / 60)}m`
    : `${Math.round(s / 3600)}h`;
};

/** Model ids are long and repetitive: keep the family and the version. */
export const modelShort = (m: string): string =>
  String(m).replace(/^claude-/, "").replace(/-\d{8}$/, "").replace(
    /-(\d)-(\d)$/,
    "-$1.$2",
  );

export const cap = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

export const hhmm = (d = new Date()): string =>
  `${String(d.getHours()).padStart(2, "0")}:${
    String(d.getMinutes()).padStart(2, "0")
  }`;

/** A path under the home folder as ~/…, whatever the home is called. */
export const shortHome = (p: string): string =>
  p.replace(/^\/(home|Users)\/[^/]+/, "~");
