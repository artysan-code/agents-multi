// passkeys.tsx — the phone's passkeys (ADR 0014): each with its fingerprint and whether a desktop endorsed it. A
// passkey counts only once this machine, with the vault, signs it: the owner compares the fingerprint with the
// phone's and confirms. Shown only when the service has a passkey.

import { useEffect, useState } from "preact/hooks";
import { endorsePasskey, loadPasskeys, type PasskeyRow, type PasskeysView, revokePasskey } from "./api.ts";
import { type Key, t } from "../../i18n.ts";
import { toast, toastErr } from "../../lib/ui.tsx";

export function Passkeys() {
  const [view, setView] = useState<PasskeysView | null>(null);
  const load = () => loadPasskeys().then(setView);
  useEffect(() => {
    load().catch(() => {});
  }, []);

  const endorse = async (p: PasskeyRow) => {
    if (!confirm(t("pk.confirm", { name: p.name, fp: p.fingerprint }))) return;
    const r = await endorsePasskey(p.id, p.fingerprint);
    toast(r.ok ? t("pk.done", { name: p.name }) : r.message ?? "", !r.ok);
    await load().catch(toastErr);
  };

  const revoke = async (p: PasskeyRow) => {
    if (!confirm(t("pk.revoke.confirm", { name: p.name, fp: p.fingerprint }))) return;
    const r = await revokePasskey(p.id);
    toast(r.ok ? t("pk.revoked", { name: p.name }) : r.message ?? "", !r.ok);
    await load().catch(toastErr);
  };

  if (!view?.passkeys.length) return null;
  return (
    <section class="panel" style={{ marginTop: "20px" }}>
      <div class="panel-h">
        <h3>{t("pk.title")}</h3>
        <button type="button" class="btn ghost sm" onClick={() => load().catch(toastErr)}>{t("pk.reload")}</button>
      </div>
      <div class="panel-b">
        <p class="sub">{t("pk.lede")}</p>
        {view.passkeys.map((p) => (
          <div class="cal-row" key={p.id}>
            <span>{p.name}</span>
            <span class="dim">{p.fingerprint}</span>
            <span class="dim">{t(`pk.state.${p.state}` as Key)}</span>
            {p.state === "pending" && view.canEndorse && (
              <button type="button" class="btn sm" onClick={() => void endorse(p)}>{t("pk.endorse")}</button>
            )}
            {p.state !== "revoked" && view.canEndorse && (
              <button type="button" class="btn ghost sm" onClick={() => void revoke(p)}>{t("pk.revoke")}</button>
            )}
          </div>
        ))}
        {!view.canEndorse && <div class="sub">{t("pk.novault")}</div>}
      </div>
    </section>
  );
}
