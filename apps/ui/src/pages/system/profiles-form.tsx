// profiles-form.tsx — the profile form, in the drawer: `name` null for a new one. Saving writes the
// profile's manifest on the server and runs install there.

import { useState } from "preact/hooks";
import { loadStatus, status } from "../../state.ts";
import { t } from "../../i18n.ts";
import { closeDrawer, openDrawer, showOutput, toast, toastErr } from "../../lib/ui.tsx";
import { saveProfile } from "./api.ts";
import { type ProfileFull, registryOf } from "./profiles-types.ts";

export function openProfileForm(name: string | null): void {
  openDrawer(name ?? t("profile.new"), () => <ProfileForm name={name} />);
}

function Field({ label, children }: { label: string; children: preact.ComponentChildren }) {
  return <label class="fld">{label}{children}</label>;
}

function ProfileForm({ name }: { name: string | null }) {
  const s = status.value!;
  const isNew = name === null;
  const p = isNew ? null : s.profiles[name] as ProfileFull;
  const m = p?.manifest ?? {};
  const registry = registryOf(s);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(isNew ? registry : p!.mcp));
  const [busy, setBusy] = useState(false);

  const toggle = (k: string) =>
    setPicked((cur) => {
      const n = new Set(cur);
      if (!n.delete(k)) n.add(k);
      return n;
    });

  const submit = async (e: Event) => {
    e.preventDefault();
    const f = (e.currentTarget as HTMLFormElement).elements;
    const val = (k: string) => (f.namedItem(k) as HTMLInputElement).value.trim();
    const body = {
      name: name ?? val("name"),
      description: val("description"),
      command: val("command"),
      alias: val("alias"),
      desktopDir: val("desktopDir"),
      mcp: registry.filter((k) => picked.has(k)),
      disableAccountMcp: (f.namedItem("disableAccountMcp") as HTMLInputElement).checked,
    };
    setBusy(true);
    try {
      const r = await saveProfile(body);
      closeDrawer();
      await loadStatus();
      toast(r.message ?? t("profile.saved", { name: body.name }));
      if (r.output) showOutput(body.name, r.output);
    } catch (err) {
      setBusy(false);
      toastErr(err);
    }
  };

  return (
    <form class="pform" onSubmit={submit}>
      {isNew && (
        <Field label={t("profile.name")}>
          <input name="name" required pattern={"[a-z][a-z0-9_\\-]{1,30}"} placeholder="research" autofocus />
        </Field>
      )}
      <Field label={t("profile.description")}>
        <input name="description" defaultValue={m.description ?? ""} placeholder={t("profile.description.ph")} />
      </Field>
      <Field label={t("profile.command")}>
        <input name="command" defaultValue={m.command ?? ""} placeholder={`claude-${name || "research"}`} />
      </Field>
      <Field label={t("profile.alias")}>
        <input name="alias" defaultValue={m.alias ?? ""} pattern={"[a-zA-Z_][a-zA-Z0-9_\\-]*"} placeholder="cr" />
      </Field>
      <Field label={t("profile.desktop")}>
        <input name="desktopDir" defaultValue={m.desktopDir ?? ""} placeholder="~/.config/Claude-Research" />
      </Field>
      <div class="fld">
        MCP
        <div class="chips">
          {registry.length
            ? registry.map((k) => (
              <button
                key={k}
                type="button"
                class={`chip pick${picked.has(k) ? " on" : ""}`}
                aria-pressed={picked.has(k)}
                onClick={() => toggle(k)}
              >
                {k}
              </button>
            ))
            : <small>{t("profile.registryEmpty")}</small>}
        </div>
      </div>
      <label class="fld check">
        <input type="checkbox" name="disableAccountMcp" defaultChecked={!!m.disableAccountMcp} /> {t("profile.disableAccountMcp")}
      </label>
      <div class="pform-foot">
        <button class="btn primary" type="submit" disabled={busy}>
          {busy ? t("profile.working") : t(isNew ? "profile.create" : "profile.save")}
        </button>
        <button class="btn ghost" type="button" onClick={closeDrawer}>{t("profile.cancel")}</button>
        <span class="hint">{t("profile.hint")}</span>
      </div>
    </form>
  );
}
