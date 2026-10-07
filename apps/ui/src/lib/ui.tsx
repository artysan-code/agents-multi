// ui.tsx — the pieces every page uses: the toast, the drawer, a profile's chip, and running an
// allowlisted action or job on the server. The toast and the drawer are signals the shell draws
// (<Overlays />), so a page opens one from an event handler without owning any markup outside itself.

import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { ndjson, post, postInit } from "../api.ts";
import { loadStatus, status } from "../state.ts";
import { t } from "../i18n.ts";

/* ---------------- toast ---------------- */

const toastSig = signal<{ msg: string; err: boolean; id: number } | null>(null);
let toastTimer: number | undefined;

export function toast(msg: string, err = false): void {
  clearTimeout(toastTimer);
  const id = Date.now();
  toastSig.value = { msg, err, id };
  toastTimer = setTimeout(() => {
    if (toastSig.value?.id === id) toastSig.value = null;
  }, err ? 6000 : 2800);
}

/** The usual catch of a page's load: the message as an error toast. */
export const toastErr = (e: unknown): void => toast(e instanceof Error ? e.message : String(e), true);

/* ---------------- drawer ---------------- */

interface DrawerState {
  title: string;
  body: () => ComponentChildren;
  wide?: boolean;
  onClose?: () => void;
}
const drawerSig = signal<DrawerState | null>(null);

/** Opens the drawer on the right; `body` is called on each redraw, so it may read signals. One drawer
 *  at a time: opening another replaces it. */
export function openDrawer(title: string, body: () => ComponentChildren, opts: { wide?: boolean; onClose?: () => void } = {}): void {
  drawerSig.value = { title, body, ...opts };
}

export function closeDrawer(): void {
  const d = drawerSig.value;
  drawerSig.value = null;
  d?.onClose?.();
}

export const drawerOpen = (): boolean => drawerSig.value !== null;

export function showOutput(title: string, text: string): void {
  openDrawer(title, () => <pre class="out">{text}</pre>);
}

function Drawer({ d }: { d: DrawerState }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [d]);
  return (
    <div>
      <div class="scrim" onClick={closeDrawer} />
      <div class={`drawer${d.wide ? " wide" : ""}`} role="dialog" aria-label={d.title}>
        <div class="dh">
          <h3>{d.title}</h3>
          <button type="button" class="x" aria-label={t("close")} onClick={closeDrawer}>×</button>
        </div>
        <div class="dbody">{d.body()}</div>
      </div>
    </div>
  );
}

/** The toast and the drawer, drawn once by the shell. */
export function Overlays() {
  const ts = toastSig.value, d = drawerSig.value;
  return (
    <>
      {d && <Drawer d={d} />}
      {ts && <div class={`toast${ts.err ? " err" : ""}`}>{ts.msg}</div>}
    </>
  );
}

/* ---------------- profiles ---------------- */

/** A profile's colour: its place among the profiles, so no name is ever spelled out here. */
export function pcolor(name: string): string {
  const names = Object.keys(status.value?.profiles ?? {}).sort();
  let i = names.indexOf(name);
  if (i < 0) i = [...String(name)].reduce((a, c) => a + c.charCodeAt(0), 0);
  return `var(--p-${(i % 4) + 1})`;
}

export function Pf({ name, label }: { name: string; label?: string }) {
  return <span class="pf" style={{ "--c": pcolor(name) }}>{label ?? name}</span>;
}

/* ---------------- actions and jobs ---------------- */

/** Runs an allowlisted action (/api/action) and shows its output; the report is reloaded after. */
export async function runAction(action: string, opts: string[] = []): Promise<void> {
  toast(t("act.running", { a: action }));
  try {
    const r = await post<{ output?: string; code: number; ms: number }>("/api/action", { action, opts });
    showOutput(action, r.output || t("act.noOutput"));
    const s = (r.ms / 1000).toFixed(1);
    toast(r.code ? t("act.doneExit", { a: action, c: r.code, s }) : t("act.done", { a: action, s }), r.code !== 0);
    await loadStatus();
  } catch (e) {
    toastErr(e);
  }
}

/** The fixes the doctor prints that the console can run itself. */
export const FIX_ACTIONS: Record<string, string> = {
  "agents-multi install": "install",
  "agents-multi mcp sync": "mcp-sync",
  "agents-multi doctor": "doctor",
  "agents-multi sync --fetch": "sync-fetch",
  "agents-multi usage ingest": "usage-ingest",
  "agents-multi update --auto": "update-now",
  "agents-multi update --check": "update-check",
  "agents-multi ui build": "ui-build",
};

export type JobEnd = { code: number; cancelled?: boolean } | { error: string };

/** Runs one job on the server (/api/job), calling `onOut` with each piece of output as it arrives;
 *  `track` receives the job id, for cancelling (/api/job/cancel). */
export async function runJob(
  action: string,
  params: Record<string, string> | undefined,
  onOut: (text: string) => void,
  track: (id: string) => void = () => {},
): Promise<JobEnd> {
  const r = await fetch("/api/job", postInit({ action, params }));
  const j = await r.json().catch(() => ({})) as { ok?: boolean; id?: string; message?: string };
  if (!j.ok || !j.id) return { error: j.message ?? String(r.status) };
  track(j.id);
  const res = await fetch(`/api/job?id=${encodeURIComponent(j.id)}`);
  let end: JobEnd | null = null;
  await ndjson<{ o?: string; done?: number; cancelled?: boolean }>(res, (m) => {
    if (m.o !== undefined) onOut(m.o);
    else if (m.done !== undefined) end = { code: m.done, cancelled: m.cancelled };
  });
  return end ?? { error: "lost" };
}
