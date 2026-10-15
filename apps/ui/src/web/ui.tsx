// ui.tsx — the small pieces every view of the web app uses: icons, the header, empty and error states,
// skeletons, the offline banner, a bottom sheet, and pull to refresh.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import mark from "../assets/mark.svg";
import { t } from "./t.ts";
import { offline } from "./state.ts";

const ICONS = {
  chat: "M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z",
  waiting: "M12 3a6 6 0 0 0-6 6c0 5-2 6-2 7h16c0-1-2-2-2-7a6 6 0 0 0-6-6zM10 20a2 2 0 0 0 4 0",
  tasks: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l2.7 2.7L16 9.5",
  brain: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h10M9 8h5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  back: "M15 5l-7 7 7 7",
  plus: "M12 5v14M5 12h14",
  send: "M12 19V5M5 12l7-7 7 7",
  stop: "M7 7h10v10H7z",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  copy: "M9 9h10v11H9zM5 15V4h10",
  check: "M5 12l4.5 4.5L19 7",
  chev: "M9 6l6 6-6 6",
  down: "M6 9l6 6 6-6",
  machine: "M4 5h16v10H4zM9 19h6M12 15v4",
  key: "M14.5 9.5a4 4 0 1 0-3.7 2.8L11 13l1 1-1 1 1 1-1.2 1.2H8v-2.5l4.2-4.2",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  out: "M10 5H5v14h5M14 8l4 4-4 4M18 12H9",
  alert: "M12 4l9 16H3zM12 10v4M12 17h.01",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5",
  refresh: "M20 11a8 8 0 0 0-14-4M4 5v4h4M4 13a8 8 0 0 0 14 4M20 19v-4h-4",
  task: "M6 4h12v16H6zM9 9h6M9 13h6",
  calendar: "M5 6h14v14H5zM5 10h14M9 3v4M15 3v4",
  mail: "M4 6h16v12H4zM4 7l8 6 8-6",
  job: "M13 3L5 14h6l-1 7 8-11h-6z",
  tool: "M14 7a4 4 0 0 0 5 5l-9 9a2.5 2.5 0 0 1-4-4l9-9a4 4 0 0 0-1-1z",
  bell: "M12 3a6 6 0 0 0-6 6c0 5-2 6-2 7h16c0-1-2-2-2-7a6 6 0 0 0-6-6zM10 20a2 2 0 0 0 4 0",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
} as const;
export type IconName = keyof typeof ICONS;

export const Icon = ({ name, size }: { name: IconName; size?: number }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" class="ic" style={size ? { width: size, height: size } : undefined}>
    <path d={ICONS[name]} />
  </svg>
);

export const Mark = ({ size = 28 }: { size?: number }) => <img class="mark" src={mark} width={size} height={size} alt="" />;

/** The top of a view: a title, a way back when it is below another, actions. */
export function Header(
  { title, sub, back, action, large }: { title: string; sub?: string; back?: string; action?: ComponentChildren; large?: boolean },
) {
  return (
    <header class={`head${large ? " large" : ""}`}>
      {back && <a class="back" href={back} aria-label={t("back")}><Icon name="back" /></a>}
      <div class="head-t">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {action && <div class="head-a">{action}</div>}
    </header>
  );
}

/** An empty list: an icon, a line, and optionally the thing to do about it. */
export function Empty({ text, icon, children }: { text: string; icon?: IconName; children?: ComponentChildren }) {
  return (
    <div class="empty">
      {icon && <span class="empty-i"><Icon name={icon} size={28} /></span>}
      <p>{text}</p>
      {children}
    </div>
  );
}

/** A failed load: a banner with the reason and a retry. */
export function Failure({ text, retry }: { text: string; retry?: () => void }) {
  return (
    <div class="banner crit" role="alert">
      <Icon name="alert" size={18} />
      <span>{text}</span>
      {retry && <button type="button" class="btn small" onClick={retry}>{t("retry")}</button>}
    </div>
  );
}

/** Rows of grey that stand where the list will be: no layout jump when it arrives. */
export function Skeleton({ rows = 5, tall }: { rows?: number; tall?: boolean }) {
  return (
    <div class={`skel${tall ? " tall" : ""}`} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} class="skel-r">
          <i style={{ width: `${55 + ((i * 17) % 35)}%` }} />
          <i class="s" style={{ width: `${30 + ((i * 11) % 30)}%` }} />
        </div>
      ))}
    </div>
  );
}

/** A thin banner over everything when the device has no network. */
export function OfflineBanner() {
  if (!offline.value) return null;
  return (
    <div class="offline" role="status">
      <Icon name="alert" size={16} />
      {t("offline")}
    </div>
  );
}

/** A bottom sheet (a centred card on a wide screen): it traps nothing but takes the focus, closes on Escape
 *  and on a tap outside, and gives the focus back. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("button, a, input, select")?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      before?.focus?.();
    };
  }, []);
  return (
    <div class="scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <div class="sheet-grab" aria-hidden="true" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Pull to refresh for a view that scrolls with the page: at the top, a pull down past a threshold reads again.
 *  The refresh is also a button for those who do not pull. */
export function usePull(refresh: () => Promise<unknown> | void) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    const down = (e: TouchEvent) => {
      start.current = scrollY <= 0 && !document.querySelector(".scrim") ? e.touches[0].clientY : null;
    };
    const move = (e: TouchEvent) => {
      if (start.current === null) return;
      const dy = e.touches[0].clientY - start.current;
      setPull(dy > 0 ? Math.min(dy * 0.5, 80) : 0);
    };
    const up = () => {
      if (start.current !== null && pull >= 56) void run();
      start.current = null;
      setPull(0);
    };
    addEventListener("touchstart", down, { passive: true });
    addEventListener("touchmove", move, { passive: true });
    addEventListener("touchend", up);
    addEventListener("touchcancel", up);
    return () => {
      removeEventListener("touchstart", down);
      removeEventListener("touchmove", move);
      removeEventListener("touchend", up);
      removeEventListener("touchcancel", up);
    };
  }, [pull, refresh]);
  const indicator = (pull > 0 || busy) && (
    <div class={`pull${busy ? " busy" : ""}`} style={{ height: busy ? 44 : pull }} role="status" aria-label={t("refreshing")}>
      <Icon name="refresh" size={20} />
    </div>
  );
  return { indicator, busy, run };
}
