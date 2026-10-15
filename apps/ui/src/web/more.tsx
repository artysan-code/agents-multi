// more.tsx — More: machines, passkeys, notifications on this device (Web Push; the VAPID key and the
// subscriptions are the service's), the theme and the language, and the account.

import { useEffect, useState } from "preact/hooks";
import { pushKey, subscribePush, unsubscribePush } from "./api.ts";
import { deviceName, isIos, keyBytes, pushAdvice, type ThemePref } from "./lib.ts";
import { PasskeyCard, PasskeyList, usePasskeys } from "./passkeys.tsx";
import { langPref, setLang, t } from "./t.ts";
import { setTheme, themePref } from "./theme.ts";
import { Header, Icon } from "./ui.tsx";

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

  const ready = advice === "ready" && on !== null;
  return (
    <section class="card" aria-labelledby="push-h">
      <div class="switch-r">
        <div>
          <h2 id="push-h">{t("push.title")}</h2>
          <p class="meta">{t("push.what")}</p>
        </div>
        {ready && (
          <button type="button" role="switch" class="switch" aria-checked={on === true} aria-labelledby="push-h" disabled={busy} onClick={on ? disable : enable}>
            <i />
          </button>
        )}
      </div>
      {advice === "install" && <p class="banner warn">{t("push.install")}</p>}
      {advice === "unsupported" && <p class="banner warn">{t("push.unsupported")}</p>}
      {advice === "denied" && <p class="banner warn">{t("push.blocked")}</p>}
      {err && <p class="err" role="alert">{err}</p>}
    </section>
  );
}

function Segmented<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: { v: T; label: string }[]; onPick: (v: T) => void }) {
  return (
    <div class="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.v} type="button" role="radio" aria-checked={value === o.v} class={value === o.v ? "on" : ""} onClick={() => onPick(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Appearance() {
  const [theme, setT] = useState<ThemePref>(themePref());
  return (
    <section class="card" aria-labelledby="look-h">
      <h2 id="look-h">{t("more.look")}</h2>
      <p class="meta">{t("more.theme")}</p>
      <Segmented
        label={t("more.theme")}
        value={theme}
        options={[{ v: "system", label: t("more.system") }, { v: "light", label: t("more.light") }, { v: "dark", label: t("more.dark") }]}
        onPick={(v) => (setTheme(v), setT(v))}
      />
      <p class="meta gap">{t("more.language")}</p>
      <Segmented
        label={t("more.language")}
        value={langPref()}
        options={[{ v: "auto", label: t("more.system") }, { v: "en", label: "English" }, { v: "it", label: "Italiano" }]}
        onPick={setLang}
      />
    </section>
  );
}

export function More() {
  const pk = usePasskeys();
  return (
    <>
      <Header large title={t("more.title")} />
      <a class="link-card" href="#machines">
        <span class="badge"><Icon name="machine" size={20} /></span>
        <span><b>{t("machines.title")}</b><small>{t("more.machinesHelp")}</small></span>
        <Icon name="chev" size={18} />
      </a>
      <Notifications />
      {pk.keys && pk.ready.length === 0 && <PasskeyCard keys={pk.keys} onChange={pk.load} />}
      <section class="card" aria-labelledby="pk-list-h">
        <h2 id="pk-list-h">{t("pk.title")}</h2>
        <p class="meta">{t("pk.what")}</p>
        <PasskeyList keys={pk.keys} err={pk.err} load={pk.load} />
        {pk.keys && pk.ready.length > 0 && <PasskeyAdd onChange={pk.load} />}
      </section>
      <Appearance />
      <section class="card" aria-labelledby="acc-h">
        <h2 id="acc-h">{t("settings.account")}</h2>
        <p><a href="/account">{t("settings.manage")}</a></p>
        <form method="post" action="/account/logout">
          <button type="submit" class="btn block"><Icon name="out" size={18} />{t("settings.signOut")}</button>
        </form>
      </section>
      <p class="foot-note">Agents Multi</p>
    </>
  );
}

/** Another passkey, when there is one already (a second phone): the same registration, behind a button. */
function PasskeyAdd({ onChange }: { onChange: () => void }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" class="btn block" onClick={() => setOpen(true)}><Icon name="plus" size={18} />{t("pk.add")}</button>;
  return <PasskeyCard keys={[]} onChange={() => (setOpen(false), onChange())} />;
}
