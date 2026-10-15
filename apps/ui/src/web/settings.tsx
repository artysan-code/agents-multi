// settings.tsx — Settings: notifications on this device (Web Push, ADR 0014: the VAPID key and the
// subscriptions are the service's), and the account.

import { useEffect, useState } from "preact/hooks";
import { pushKey, subscribePush, unsubscribePush } from "./api.ts";
import { deviceName, isIos, keyBytes, pushAdvice } from "./lib.ts";
import { t } from "./t.ts";
import { Header } from "./ui.tsx";

const supported = () => "serviceWorker" in navigator && "PushManager" in globalThis && "Notification" in globalThis;
const standalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

function Notifications() {
  const [on, setOn] = useState<boolean | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ios = isIos(navigator.userAgent, navigator.maxTouchPoints);
  const advice = pushAdvice({
    hasApi: supported(),
    ios,
    standalone: standalone(),
    permission: "Notification" in globalThis ? Notification.permission : "default",
  });

  useEffect(() => {
    if (advice !== "ready" && advice !== "denied") return;
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => setOn(!!s), () => setOn(false));
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      if (await Notification.requestPermission() !== "granted") throw new Error(t("push.denied"));
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(await pushKey()) });
      const keys = sub.toJSON().keys;
      if (!keys?.p256dh || !keys.auth) throw new Error(t("push.failed"));
      await subscribePush({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, device: deviceName(navigator.userAgent, navigator.maxTouchPoints) });
      setOn(true);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  const disable = async () => {
    setBusy(true);
    try {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) {
        await unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setOn(false);
      setErr("");
    } catch (e) {
      setErr((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <section class="card">
      <h2>{t("push.title")}</h2>
      <p class="meta">{t("push.what")}</p>
      {advice === "install" && <p class="note">{t("push.install")}</p>}
      {advice === "unsupported" && <p class="note">{t("push.unsupported")}</p>}
      {advice === "denied" && <p class="note">{t("push.blocked")}</p>}
      {advice === "ready" && on === false && <button type="button" class="btn primary" disabled={busy} onClick={enable}>{t("push.enable")}</button>}
      {advice === "ready" && on === true && (
        <>
          <p class="ok">{t("push.on")}</p>
          <button type="button" class="btn" disabled={busy} onClick={disable}>{t("push.disable")}</button>
        </>
      )}
      {err && <p class="err" role="alert">{err}</p>}
    </section>
  );
}

export function Settings() {
  return (
    <>
      <Header title={t("settings.title")} />
      <Notifications />
      <section class="card">
        <h2>{t("settings.account")}</h2>
        <p><a href="/account">{t("settings.manage")}</a></p>
        <form method="post" action="/account/logout">
          <button type="submit" class="btn">{t("settings.signOut")}</button>
        </form>
      </section>
    </>
  );
}
