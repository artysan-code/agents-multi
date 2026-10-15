// passkeys.tsx — the phone's yes: a passkey of the account, registered here, that counts once a desktop with the
// vault has endorsed it (ADR 0014, G5). The hook that reads them, the card that makes one, and the list to revoke.

import { useEffect, useState } from "preact/hooks";
import { addPasskey, listPasskeys, passkeyOptions, revokePasskey } from "./api.ts";
import { deviceName, endorsed, type Explained, explainError, type Passkey, pending } from "./lib.ts";
import { dateOf, t, tk } from "./t.ts";
import { createPasskey, passkeysSupported } from "./webauthn.ts";
import { Failure, Icon, Skeleton } from "./ui.tsx";

/** What a failed passkey call tells the person: the browser's own error name and message, as they are, and when the
 *  name is one a person can act on, a line about what to do. */
export const explain = (e: unknown): Explained => explainError(e as Error, typeof DOMException !== "undefined" && e instanceof DOMException);

export function PkError({ e }: { e: Explained }) {
  const hint = e.hint && tk(`pk.hint.${e.hint}`);
  return (
    <div class="pk-err" role="alert">
      <p class="err">{e.name ? <b>{e.name}</b> : null}{e.name ? ": " : ""}{e.message}</p>
      {hint && <p class="meta">{hint}</p>}
    </div>
  );
}

export function usePasskeys() {
  const [keys, setKeys] = useState<Passkey[] | null>(null);
  const [err, setErr] = useState("");
  const load = () => listPasskeys().then((k) => (setKeys(k), setErr("")), (e: Error) => setErr(e.message));
  useEffect(() => {
    void load();
  }, []);
  return { keys, err, load, ready: keys ? endorsed(keys) : [], waiting: keys ? pending(keys) : [] };
}

/** The first run: what a passkey is for, a name for this device, and the button that makes one. Once there is
 *  one that waits for a desktop, it says so and what to do there. */
export function PasskeyCard({ keys, onChange }: { keys: Passkey[]; onChange: () => void }) {
  const [name, setName] = useState(deviceName(navigator.userAgent, navigator.maxTouchPoints));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Explained | null>(null);
  const wait = pending(keys);
  if (endorsed(keys).length) return null;

  const make = async () => {
    setBusy(true);
    try {
      const options = await passkeyOptions();
      const credential = await createPasskey(options);
      await addPasskey(name.trim() || "Phone", credential);
      setErr(null);
      onChange();
    } catch (e) {
      setErr(explain(e));
    }
    setBusy(false);
  };

  return (
    <section class="card hero" aria-labelledby="pk-h">
      <span class="hero-i"><Icon name="key" size={24} /></span>
      <h2 id="pk-h">{wait.length ? t("pk.pendingTitle") : t("pk.firstTitle")}</h2>
      {wait.length > 0
        ? (
          <>
            <p>{t("pk.pendingHelp")}</p>
            <ul class="plain">
              {wait.map((k) => <li key={k.id}><b>{k.name}</b> <span class="tag warn">{t("pk.pending")}</span></li>)}
            </ul>
            <p class="meta">{t("pk.endorse")}</p>
            <code class="cmd">agents passkeys</code>
          </>
        )
        : (
          <>
            <p>{t("pk.firstHelp")}</p>
            {!passkeysSupported() && <p class="banner warn">{t("pk.unsupported")}</p>}
            {passkeysSupported() && (
              <>
                <label class="field">
                  <span>{t("pk.name")}</span>
                  <input type="text" value={name} maxLength={40} onInput={(e) => setName(e.currentTarget.value)} />
                </label>
                <button type="button" class="btn primary block" disabled={busy} onClick={make}>
                  {busy ? t("pk.making") : t("pk.make")}
                </button>
                <p class="meta">{t("pk.endorseAfter")}</p>
              </>
            )}
          </>
        )}
      {err && <PkError e={err} />}
    </section>
  );
}

/** The account's passkeys, each with its state and a way to revoke it. */
export function PasskeyList({ keys, err, load }: { keys: Passkey[] | null; err: string; load: () => void }) {
  const [busy, setBusy] = useState("");
  const [fail, setFail] = useState("");
  const revoke = async (k: Passkey) => {
    if (!confirm(t("pk.revokeAsk", { n: k.name }))) return;
    setBusy(k.id);
    await revokePasskey(k.id).then(() => (setFail(""), load()), (e: Error) => setFail(e.message));
    setBusy("");
  };
  return (
    <>
      {err && <Failure text={err} retry={load} />}
      {!keys && !err && <Skeleton rows={2} />}
      {keys && !keys.length && <p class="meta pad">{t("pk.none")}</p>}
      {keys && keys.length > 0 && (
        <ul class="rows flat">
          {keys.map((k) => (
            <li key={k.id} class="pk-r">
              <span class="pk-t">
                <b>{k.name}</b>
                <small>{dateOf(k.created, { day: "numeric", month: "short", year: "numeric" })}</small>
              </span>
              <span class={`tag ${k.endorsement ? "ok" : "warn"}`}>{k.endorsement ? t("pk.endorsed") : t("pk.pending")}</span>
              <button type="button" class="btn small ghost" disabled={busy === k.id} aria-label={t("pk.revoke", { n: k.name })} onClick={() => void revoke(k)}>
                <Icon name="trash" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {fail && <p class="err pad" role="alert">{fail}</p>}
    </>
  );
}
