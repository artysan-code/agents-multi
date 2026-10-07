// health.tsx — System › Health: what needs you first, in the panel; what passes below, by area and
// folded. The model for a ported page: it reads the shared report, owns only its local state (the
// re-run), and writes no markup by hand.

import { useState } from "preact/hooks";
import type { Check } from "../../api.ts";
import { loadStatus, status } from "../../state.ts";
import { type Key, t } from "../../i18n.ts";

type Area = "brain" | "mcp" | "desktop" | "profiles" | "setup";
type Row = Omit<Check, "status"> & { status: Check["status"] | "run" };

const AREAS: [Area, RegExp][] = [
  ["brain", /^(brain|tasks)\b|^mcp\.(brain|tasks)$/],
  ["mcp", /^(mcp|vault)\b/],
  ["desktop", /^(desktop|app)\b/],
  ["profiles", /^(profile|bin|stub|zshrc|config)\b/],
  ["setup", /./],
];
const areaOf = (id: string): Area => AREAS.find(([, re]) => re.test(id))![0];
const SYM = { ok: "✓", warn: "!", fail: "✕", run: "◠" } as const;
const ORDER = { fail: 0, warn: 1, run: 2, ok: 3 } as const;

function CheckRow({ c }: { c: Row }) {
  return (
    <div class="chk">
      <span class={`ic ${c.status}`}>{c.status === "run" ? <span class="spin">◠</span> : SYM[c.status]}</span>
      <div>
        <div class="name">{c.msg}</div>
        <div class="msg">{c.id}</div>
      </div>
      {c.status !== "ok" && c.fix ? <code class="fix">{c.fix}</code> : <span />}
    </div>
  );
}

export function Health() {
  const [running, setRunning] = useState(false);
  const checks: Row[] = running
    ? (status.value?.doctor ?? []).map((c) => ({ ...c, status: "run", msg: t("health.checking"), fix: undefined }))
    : status.value?.doctor ?? [];
  const todo = checks.filter((c) => c.status !== "ok").sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  const ok = checks.filter((c) => c.status === "ok");
  const n = (s: Row["status"]) => checks.filter((c) => c.status === s).length;

  const rerun = async () => {
    setRunning(true);
    try {
      await loadStatus(true);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div class="sub-view">
      <div class="panel">
        <div class="panel-h">
          <h3>{t("health.checks")}</h3>
          <span class="r">{t("health.sum", { ok: n("ok"), w: n("warn"), f: n("fail") })}</span>
          <button type="button" class="btn" disabled={running} onClick={rerun}>{t("health.rerun")}</button>
        </div>
        <div class="checks">
          {todo.length
            ? todo.map((c) => <CheckRow key={c.id} c={c} />)
            : <div class="chk-none">{t("health.allGood", { n: checks.length })}</div>}
        </div>
      </div>
      {AREAS.map(([a]) => {
        const list = ok.filter((c) => areaOf(c.id) === a);
        if (!list.length) return null;
        return (
          <details key={a} class="panel chk-area">
            <summary>
              <span class="ic ok">✓</span>
              <b>{t(`health.area.${a}` as Key)}</b>
              <span class="sub">{t("health.areaOk", { n: list.length })}</span>
            </summary>
            <div class="checks">{list.map((c) => <CheckRow key={c.id} c={c} />)}</div>
          </details>
        );
      })}
    </div>
  );
}
