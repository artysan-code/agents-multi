// notify.ts — il doctor che viene da te: `claude-multi doctor --notify` confronta l'esito con l'ultimo
// salvato e manda UNA notifica KDE solo quando compare un fail nuovo (o un fail sparisce, per dire
// che è tornato tutto ok). Nessuna notifica per i warn: sarebbero rumore ogni 4 ore.
// Lanciato dal timer claude-update-check (secondo ExecStart della unit), a fianco del check aggiornamenti.

import { type Check, has, run, STATE } from "./lib.ts";

const STATE_FILE = `${STATE}/doctor-last.json`;
export interface DoctorDiff { newFails: Check[]; gone: string[]; stillFails: Check[]; recovered: boolean }

/** Pura: confronta i fail precedenti (id) con quelli correnti. `recovered` = prima c'erano fail, ora zero. */
export function diffDoctor(prevFailIds: string[], current: Check[]): DoctorDiff {
  const fails = current.filter((c) => c.status === "fail");
  const prev = new Set(prevFailIds);
  const cur = new Set(fails.map((c) => c.id));
  return {
    newFails: fails.filter((c) => !prev.has(c.id)),
    gone: prevFailIds.filter((id) => !cur.has(id)),
    stillFails: fails.filter((c) => prev.has(c.id)),
    recovered: prevFailIds.length > 0 && fails.length === 0,
  };
}

export function notifyText(d: DoctorDiff): { title: string; body: string; urgency: "normal" | "critical" } | null {
  if (d.newFails.length) {
    const lines = d.newFails.slice(0, 3).map((c) => `• ${c.msg}${c.fix ? `\n   → ${c.fix}` : ""}`);
    const more = d.newFails.length > 3 ? `\n… e altri ${d.newFails.length - 3}` : "";
    const still = d.stillFails.length ? `\n(${d.stillFails.length} già noti)` : "";
    return { title: `claude-multi: ${d.newFails.length} problem${d.newFails.length === 1 ? "a nuovo" : "i nuovi"}`, body: lines.join("\n") + more + still, urgency: "critical" };
  }
  if (d.recovered) return { title: "claude-multi: tutto ok", body: `Risolti: ${d.gone.join(", ")}`, urgency: "normal" };
  return null;
}

export async function loadLast(): Promise<string[]> {
  try { return JSON.parse(await Deno.readTextFile(STATE_FILE)).fails ?? []; } catch { return []; }
}
export async function saveLast(current: Check[]) {
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(STATE_FILE, JSON.stringify({ at: new Date().toISOString(), fails: current.filter((c) => c.status === "fail").map((c) => c.id) }, null, 2) + "\n");
}

/** Manda la notifica (se c'è qualcosa da dire). dryRun: stampa e basta. Ritorna true se ha notificato. */
export async function notifyDoctor(current: Check[], opts: { dryRun?: boolean } = {}) {
  const d = diffDoctor(await loadLast(), current);
  const t = notifyText(d);
  if (!opts.dryRun) await saveLast(current);
  if (!t) return false;
  if (opts.dryRun || !(await has("notify-send"))) { console.log(`[notifica${opts.dryRun ? " dry-run" : " (notify-send assente)"}] ${t.title}\n${t.body}`); return true; }
  // Nessun --wait: la unit non deve restare appesa. L'azione "apri" non è disponibile senza --wait,
  // quindi il corpo porta già il fix; il pannello si apre dal menu «Claude — aggiornamenti e stato».
  await run("notify-send", ["-a", "claude-multi", "-i", "claude-desktop", "-u", t.urgency, "--expire-time=600000", t.title, t.body]);
  return true;
}
