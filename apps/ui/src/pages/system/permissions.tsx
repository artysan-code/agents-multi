// permissions.tsx — System › Permissions: the rules every profile starts from, in three lists
// (Allowed, Ask first, Denied). A rule moves between them by drag and drop or by the select on it;
// moving one towards Allowed is the unsafe direction and asks first.

import { Fragment } from "preact";
import { useRef, useState } from "preact/hooks";
import { get, post } from "../../api.ts";
import { useTopic } from "../../state.ts";
import { type Key, t } from "../../i18n.ts";
import { toast, toastErr } from "../../lib/ui.tsx";

type List = "allow" | "ask" | "deny";
const LISTS: List[] = ["allow", "ask", "deny"];

interface Permissions {
  mode: string;
  rules: Record<List, string[]>;
  profiles: Record<string, { mode?: string; lists: Record<string, { added: string[]; dropped: string[] }> }>;
}

const MODES = ["default", "acceptEdits", "plan", "auto"];

export function Permissions() {
  const [perm, setPerm] = useState<Permissions | null>(null);
  const [over, setOver] = useState<List | null>(null);
  const drag = useRef<{ from: List; rule: string } | null>(null);

  const load = async () => {
    try {
      setPerm(await get<Permissions>("/api/permissions"));
    } catch (e) {
      toastErr(e);
    }
  };
  useTopic(load, ["state"]);

  const op = async (body: Record<string, string>) => {
    const r = await post<{ ok: boolean; message?: string }>("/api/permissions", body).catch((e: Error) => ({
      ok: false,
      message: e.message,
    }));
    if (r.message) toast(r.message, !r.ok);
    if (r.ok) await load();
  };

  const move = (from: List, to: List, rule: string) => {
    if (from === to) return;
    if (to === "allow" && !confirm(t("perm.move.confirm", { r: rule, l: t(`perm.${from}` as Key) }))) return;
    void op({ op: "move", from, to, rule });
  };

  if (!perm) return <div class="sub-view" />;
  const profs = Object.entries(perm.profiles).filter(([, v]) => v.mode || Object.keys(v.lists).length);

  return (
    <div class="sub-view">
      <p class="lede">{t("perm.lede")}</p>
      <div class="perm-mode" style={{ marginTop: "18px" }}>
        <label class="fld" style={{ flexDirection: "row", alignItems: "center", gap: "10px" }}>
          <span>{t("perm.mode")}</span>
          <select
            class="sel"
            style={{ fontSize: "13px", padding: "6px 8px" }}
            value={perm.mode}
            onChange={(e) => op({ op: "mode", mode: e.currentTarget.value })}
          >
            {MODES.map((m) => <option key={m} value={m}>{t(`perm.m.${m}` as Key)}</option>)}
          </select>
        </label>
      </div>
      <div class="perm-lists">
        {LISTS.map((l) => (
          <section
            key={l}
            class={`panel perm-list${over === l ? " over" : ""}`}
            onDragOver={(e) => {
              if (!drag.current) return;
              e.preventDefault();
              setOver(l !== drag.current.from ? l : null);
            }}
            onDrop={(e) => {
              if (!drag.current) return;
              e.preventDefault();
              const d = drag.current;
              drag.current = null;
              setOver(null);
              move(d.from, l, d.rule);
            }}
          >
            <div class="panel-h">
              <h3>{t(`perm.${l}` as Key)}</h3>
              <span class="r">{perm.rules[l].length}</span>
            </div>
            <div class="panel-b">
              <span class="sub">{t(`perm.${l}.what` as Key)}</span>
              {perm.rules[l].length
                ? perm.rules[l].map((r) => (
                  <div
                    class="perm-rule"
                    key={r}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer?.setData("text/plain", r);
                      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
                      drag.current = { from: l, rule: r };
                      (e.currentTarget as HTMLElement).classList.add("dragging");
                    }}
                    onDragEnd={(e) => {
                      drag.current = null;
                      setOver(null);
                      (e.currentTarget as HTMLElement).classList.remove("dragging");
                    }}
                  >
                    <code>{r}</code>
                    <select
                      class="perm-move"
                      aria-label={t("perm.move")}
                      value=""
                      onChange={(e) => {
                        const to = e.currentTarget.value as List;
                        e.currentTarget.value = "";
                        if (to) move(l, to, r);
                      }}
                    >
                      <option value="">{t("perm.move")}</option>
                      {LISTS.filter((o) => o !== l).map((o) => <option key={o} value={o}>{t(`perm.${o}` as Key)}</option>)}
                    </select>
                    <button
                      type="button"
                      aria-label={t("perm.remove")}
                      onClick={() => op({ op: "remove", list: l, rule: r })}
                    >
                      ×
                    </button>
                  </div>
                ))
                : <span class="sub">—</span>}
            </div>
            <AddRule onAdd={(rule) => op({ op: "add", list: l, rule })} />
          </section>
        ))}
      </div>
      <div>
        {profs.map(([p, v]) => (
          <section class="panel perm-prof" key={p}>
            <div class="panel-h">
              <h3>{p}</h3>
              <span class="r">{t("perm.own")}</span>
              {Object.keys(v.lists).length > 0 && (
                <button
                  type="button"
                  class="btn sm"
                  onClick={() => confirm(t("perm.promote.confirm", { p })) && op({ op: "promote", profile: p })}
                >
                  {t("perm.promote")}
                </button>
              )}
            </div>
            <div class="panel-b">
              {v.mode && <div>{t("perm.mode")}: <code>{v.mode}</code></div>}
              {Object.entries(v.lists).map(([l, d]) => (
                <div key={l}>
                  <b>{t(`perm.${l}` as Key)}</b>
                  {d.added.length > 0 && <Rules label={t("perm.added")} rules={d.added} />}
                  {d.dropped.length > 0 && <Rules label={t("perm.dropped")} rules={d.dropped} />}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function Rules({ label, rules }: { label: string; rules: string[] }) {
  return (
    <div class="sub">
      {label}: {rules.map((r, i) => <Fragment key={r}>{i > 0 && " · "}<code>{r}</code></Fragment>)}
    </div>
  );
}

function AddRule({ onAdd }: { onAdd: (rule: string) => Promise<void> }) {
  const [v, setV] = useState("");
  return (
    <form
      class="perm-add"
      onSubmit={async (e) => {
        e.preventDefault();
        const rule = v.trim();
        if (!rule) return;
        await onAdd(rule);
        setV("");
      }}
    >
      <input
        class="search"
        placeholder="Bash(npm test:*)"
        required
        autocomplete="off"
        value={v}
        onInput={(e) => setV(e.currentTarget.value)}
      />
      <button class="btn sm" type="submit">{t("perm.add")}</button>
    </form>
  );
}
