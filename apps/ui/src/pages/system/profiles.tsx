// profiles.tsx — System › Profiles: one row per profile, edited in the drawer (profiles-form.tsx).

import type { ComponentChildren } from "preact";
import { status } from "../../state.ts";
import { useIntent } from "../../router.ts";
import { t } from "../../i18n.ts";
import { shortHome } from "../../lib/format.ts";
import { openProfileForm } from "./profiles-form.tsx";
import { profilesOf } from "./profiles-types.ts";

/** A string with <code>…</code> in it, as JSX: the dictionary keeps the markup, the page never injects it. */
function WithCode({ text }: { text: string }) {
  const parts: ComponentChildren[] = [];
  text.split(/(<code>.*?<\/code>)/g).forEach((p, i) => {
    const m = p.match(/^<code>(.*)<\/code>$/);
    parts.push(m ? <code key={i}>{m[1]}</code> : p);
  });
  return <>{parts}</>;
}

export function Profiles() {
  useIntent("profiles.new", () => openProfileForm(null));
  const s = status.value;
  if (!s) return <div class="sub-view" />;
  const rows = profilesOf(s);
  const live = new Set(s.running.cli.map((c) => c.profile));
  return (
    <div class="sub-view">
      <div class="panel">
        <div class="panel-h">
          <h3>{t("sys.profiles")}</h3>
          <span class="r">{t("profile.count", { n: rows.length })}</span>
          <button type="button" class="btn primary" onClick={() => openProfileForm(null)}>{t("profile.add")}</button>
        </div>
        <div>
          {rows.map(([n, p]) => {
            const isLive = live.has(n);
            return (
              <div class="plist-row" key={n}>
                <div class="pwho">
                  <span class={`dot${isLive ? " active" : ""}`} title={t(isLive ? "profile.live" : "profile.idle")} />
                  <div style={{ minWidth: 0 }}>
                    <b>{n}</b>
                    <small>{p.account ?? t("profile.notSignedIn")}</small>
                  </div>
                </div>
                <div class="pcell">
                  <code>{p.manifest.command ?? `claude-${n}`}</code>
                  {p.manifest.alias && <>{" "}<span class="chip">{p.manifest.alias}</span></>}
                  <small title={p.desktopDir ?? ""}>{shortHome(p.desktopDir ?? "")}</small>
                </div>
                <div class="pcell">
                  {t("profile.mountedVal", {
                    s: Object.keys(p.mounted.skills).length,
                    a: Object.keys(p.mounted.agents).length,
                    c: Object.keys(p.mounted.commands).length,
                  })}
                  <small>{t(p.manifest.disableAccountMcp ? "profile.accountMcpOff" : "profile.accountMcpOn")}</small>
                </div>
                <div class="pcell chips">
                  {p.mcp.length
                    ? p.mcp.map((m) => <span key={m} class="chip on">{m}</span>)
                    : <small>{t("profile.noMcp")}</small>}
                </div>
                <button type="button" class="btn" onClick={() => openProfileForm(n)}>{t("profile.edit")}</button>
              </div>
            );
          })}
        </div>
      </div>
      <p class="note"><WithCode text={t("profiles.note")} /></p>
    </div>
  );
}
