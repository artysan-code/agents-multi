// index.tsx — the Connections page: the vault and Google client cards when something is to be done,
// what is not yet applied to Claude, the services with their accounts (filtered by profile), the
// calendars the day shows, and Agents Multi's own (brain and tasks) at the bottom.

import { useState } from "preact/hooks";
import { type AccountsView, importGoogleClient, loadAccounts } from "./api.ts";
import { Ours, Services, VaultCard } from "./accounts.tsx";
import { Calendars } from "./calendars.tsx";
import { openAccountForm } from "./form.tsx";
import { t } from "../../i18n.ts";
import { runAction, toast, toastErr } from "../../lib/ui.tsx";
import { useTopic } from "../../state.ts";

/** How the last Google connection or brain sign-in ended, shown once when the browser comes back. */
let seenConnect: string | undefined;

function readFilter(): string {
  try {
    return localStorage.getItem("conn.filter") ?? "";
  } catch {
    return "";
  }
}

function GoogleClientCard({ reload }: { reload: () => void }) {
  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement, file = input.files?.[0];
    if (!file) return;
    const r = await importGoogleClient(await file.text());
    toast(r.message ?? "", !r.ok);
    if (r.ok) reload();
    input.value = "";
  };
  return (
    <div class="status-card update" style={{ marginTop: "12px" }}>
      <i />
      <div>
        <b>{t("google.client")}</b>
        <div class="sub">{t("google.client.how")}</div>
      </div>
      <label class="btn">
        {t("google.client.import")}
        <input type="file" accept=".json,application/json" hidden onChange={onFile} />
      </label>
    </div>
  );
}

export function Connections() {
  const [view, setView] = useState<AccountsView | null>(null);
  const [filter, setFilter] = useState(readFilter);

  const load = () =>
    loadAccounts().then((v) => {
      setView(v);
      const last = v.google.last;
      if (last && last.at !== seenConnect) {
        if (seenConnect !== undefined) toast(last.message, !last.ok);
        seenConnect = last.at;
      }
    }).catch(toastErr);
  useTopic(load, ["state"]);

  if (!view) return <div class="sub-view" />;

  const pick = (p: string) => {
    setFilter(p);
    try {
      localStorage.setItem("conn.filter", p);
    } catch { /* storage off */ }
  };
  const sees = (ps?: string[]) => !filter || !ps || ps.includes(filter);
  const accs = view.accounts.filter((a) => sees(a.profiles));
  const servers = view.servers.filter((sv) => sees(sv.profiles));
  // what a sync would still change: one notice for the whole page, not a word in every row
  const pending = [...view.accounts.map((a) => a.reach), ...view.servers].filter((r) => r.pending.length).length;
  const wantsGoogle = view.services.includes("google") && view.vault.state === "ok" && !view.google.client;

  return (
    <div class="sub-view">
      <h1 class="pg-h">{t("nav.connections")}</h1>
      <p class="lede">{t("conn.lede")}</p>
      <VaultCard v={view.vault} />
      {wantsGoogle && <GoogleClientCard reload={load} />}
      {pending > 0 && (
        <div class="status-card update" style={{ marginTop: "12px" }}>
          <i />
          <div>
            <b>{t("conn.apply.title", { n: pending })}</b>
            <div class="sub">{t("conn.apply.how")}</div>
          </div>
          <button type="button" class="btn" onClick={() => runAction("mcp-sync")}>{t("conn.apply")}</button>
        </div>
      )}
      <div class="conn-bar">
        <span class="sub">{t("conn.show")}</span>
        <div class="chips">
          {["", ...view.profiles].map((p) => (
            <button key={p} type="button" class={`chip pick${p === filter ? " on" : ""}`} onClick={() => pick(p)}>
              {p || t("conn.all")}
            </button>
          ))}
        </div>
        <span class="r">{t("acc.sum", { n: accs.length })}</span>
        <button type="button" class="btn ghost sm" title={t("conn.check.title")} onClick={() => runAction("mcp-check")}>
          {t("conn.check")}
        </button>
        <button type="button" class="btn primary" onClick={() => openAccountForm(view, null, load)}>{t("acc.add")}</button>
      </div>
      <Services view={view} accs={accs} servers={servers} reload={load} />
      <Calendars />
      <h3 class="conn-h">{t("conn.ours")}</h3>
      <Ours view={view} accs={accs} reload={load} />
    </div>
  );
}
