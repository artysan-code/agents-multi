// calendars.tsx — the calendars the day shows: every connected Google account's, found by asking
// Google, each with a switch.

import { useEffect, useState } from "preact/hooks";
import { type AccountCalendars, loadCalendars, setShown } from "./api.ts";
import { t } from "../../i18n.ts";
import { toast, toastErr } from "../../lib/ui.tsx";

export function Calendars() {
  const [cals, setCals] = useState<AccountCalendars[] | null>(null);
  const load = (fresh = false) => loadCalendars(fresh).then(setCals);
  useEffect(() => {
    load().catch(toastErr);
  }, []);

  const toggle = async (account: string, id: string, shown: boolean) => {
    const r = await setShown(account, id, shown);
    if (!r.ok) toast(r.message ?? "", true);
    await load().catch(() => {});
    if (r.ok) toast(t("cal.saved"));
  };

  if (!cals?.length) return null;
  return (
    <section class="panel" style={{ marginTop: "20px" }}>
      <div class="panel-h">
        <h3>{t("cal.title")}</h3>
        <button type="button" class="btn ghost sm" onClick={() => load(true).catch(toastErr)}>{t("cal.reload")}</button>
      </div>
      <div class="panel-b">
        {cals.map((a) => (
          <div class="cal-acc" key={a.account}>
            <div class="acct-h">
              {a.account}
              {a.email && <> <span class="dim">{a.email}</span></>}
            </div>
            {a.state === "ok"
              ? a.calendars.map((c) => (
                <label class="cal-row" key={c.id}>
                  <input type="checkbox" checked={c.shown} onChange={(e) => toggle(a.account, c.id, e.currentTarget.checked)} />
                  <i style={{ background: c.color }} />
                  <span>{c.name}</span>
                  {c.primary && <span class="dim">{t("cal.primary")}</span>}
                  {(c.role === "reader" || c.role === "freeBusyReader") && <span class="dim">{t("cal.readonly")}</span>}
                  {c.noisy && <span class="dim">{t("cal.noisy")}</span>}
                </label>
              ))
              : <div class="sub">{t(a.state === "disconnected" ? "cal.disconnected" : "cal.error", { m: a.message ?? "" })}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
