// form.tsx — the account form, in the drawer: `account` null for a new one. The secret field is never
// filled in: the page never receives a secret, it only sends one.

import { useState } from "preact/hooks";
import type { Account, AccountsView } from "./api.ts";
import { saveAccount } from "./api.ts";
import { t } from "../../i18n.ts";
import { closeDrawer, openDrawer, toast } from "../../lib/ui.tsx";

function AccountForm(
  { view, account: a, reload }: {
    view: AccountsView;
    account: Account | null;
    reload: () => void;
  },
) {
  const [service, setService] = useState(a?.service ?? view.services[0] ?? "");
  const [name, setName] = useState(a?.name ?? "");
  const [url, setUrl] = useState(a?.url ?? "");
  const [picked, setPicked] = useState<string[]>(a?.profiles ?? []);
  const [secret, setSecret] = useState("");
  // a Google account has no secret to paste: it is connected through its consent page
  const isGoogle = service === "google";

  const send = async (op: "save" | "delete") => {
    const body = {
      op,
      service,
      name: name.trim(),
      url: url.trim(),
      profiles: picked,
      secret,
    };
    setSecret("");
    const r = await saveAccount(body);
    toast(r.message ?? "", !r.ok || !!r.missing?.length);
    if (r.ok) {
      closeDrawer();
      reload();
    }
  };
  const pick = (p: string) =>
    setPicked(
      picked.includes(p) ? picked.filter((x) => x !== p) : [...picked, p],
    );

  return (
    <form
      class="pform"
      onSubmit={(e) => {
        e.preventDefault();
        void send("save");
      }}
    >
      <label class="fld">
        {t("acc.service")}
        {a ? <input name="service" value={a.service} readOnly /> : (
          <select
            name="service"
            class="sel"
            style={{ fontSize: "14px", padding: "8px" }}
            value={service}
            onChange={(e) => setService(e.currentTarget.value)}
          >
            {view.services.map((sv) => <option key={sv}>{sv}</option>)}
          </select>
        )}
      </label>
      <label class="fld">
        {t("acc.name")} <small>{t("acc.name.hint")}</small>
        <input
          name="name"
          required
          pattern="[a-z][a-z0-9_-]{0,30}"
          value={name}
          readOnly={!!a}
          placeholder="alice"
          onInput={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label class="fld">
        {t("acc.url")}
        <input
          name="url"
          value={url}
          placeholder="https://…"
          onInput={(e) => setUrl(e.currentTarget.value)}
        />
      </label>
      <div class="fld">
        {t("conn.profiles")} <small>{t("acc.profiles.hint")}</small>
        <div class="chips">
          {view.profiles.map((p) => (
            <button
              key={p}
              type="button"
              class={`chip pick${picked.includes(p) ? " on" : ""}`}
              aria-pressed={picked.includes(p)}
              onClick={() => pick(p)}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      {isGoogle
        ? <p class="sub acc-google">{t("google.form.hint")}</p>
        : (
          <div class="acc-secret">
            <label class="fld">
              {t("acc.secret")} <small>{t("acc.secret.hint")}</small>
              <input
                name="secret"
                type="password"
                autocomplete="off"
                required={!a}
                value={secret}
                placeholder={t(a ? "acc.secret.keep" : "acc.secret.ph")}
                onInput={(e) => setSecret(e.currentTarget.value)}
              />
            </label>
          </div>
        )}
      <div class="pform-foot">
        <button class="btn primary" type="submit">{t("conn.save")}</button>
        {a && (
          <button
            class="btn ghost danger"
            type="button"
            onClick={() => {
              if (
                confirm(t("acc.confirmDelete", { a: `${a.service}/${a.name}` }))
              ) void send("delete");
            }}
          >
            {t("conn.remove")}
          </button>
        )}
        <button class="btn ghost" type="button" onClick={closeDrawer}>
          {t("conn.cancel")}
        </button>
      </div>
    </form>
  );
}

export function openAccountForm(
  view: AccountsView,
  account: Account | null,
  reload: () => void,
): void {
  openDrawer(
    account ? `${account.service}/${account.name}` : t("acc.new"),
    () => <AccountForm view={view} account={account} reload={reload} />,
  );
}
