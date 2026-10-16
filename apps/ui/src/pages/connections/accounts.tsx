// accounts.tsx — the rows of Connections: one block per service with its accounts inside, each with
// one state in plain words and one action; servers that need no account; brain and tasks apart.

import type { ComponentChildren } from "preact";
import type { Account, AccountsView, Reach, Server } from "./api.ts";
import { startLogin } from "./api.ts";
import { Logo, svcName } from "./logo.tsx";
import { openAccountForm } from "./form.tsx";
import { type Key, t, tk } from "../../i18n.ts";
import { openDrawer, toast } from "../../lib/ui.tsx";
import { ManualLink } from "../../lib/login-link.tsx";
import { useState } from "preact/hooks";
import { post } from "../../api.ts";
import { PairCard } from "./pair.tsx";
import { AddServerCard } from "../servers/add.tsx";

const Chips = ({ ps }: { ps?: string[] }) =>
  ps ? <>{ps.map((p) => <span class="chip on" key={p}>{p}</span>)}</> : <span class="sub">{t("acc.allProfiles")}</span>;

type State = { cls: string; text: string; sub?: { text: string; code?: boolean } };

const desktopNote = (r: Reach) => r.noDesktop.length ? { text: t("conn.noDesktop", { p: r.noDesktop.join(", ") }) } : undefined;

/** The one state of an account, most urgent first. */
function accState(a: Account): State {
  const r = a.reach, desk = desktopNote(r);
  if (a.missing.length) {
    const m = a.missing[0];
    return {
      cls: "warn-t",
      text: t("acc.missingProgram", { s: m.server }),
      sub: m.install ? { text: m.install, code: true } : undefined,
    };
  }
  if (a.service === "google" && !a.hasSecret) return { cls: "warn-t", text: t("google.notConnected") };
  if (a.service === "brain" && !a.hasSecret) return { cls: "warn-t", text: t("conn.brainOff") };
  if (a.auth !== "oauth" && a.service !== "google" && a.service !== "brain" && !a.hasSecret) {
    return { cls: "warn-t", text: t("acc.noSecret") };
  }
  if (r.pending.length) return { cls: "warn-t", text: t("conn.pending", { p: r.pending.join(", ") }), sub: desk };
  if (!r.profiles.length) return { cls: "sub", text: t("conn.unused") };
  if (a.auth === "oauth") return { cls: "sub", text: t("acc.oauth"), sub: desk };
  if (a.service === "brain") return { cls: "ok-t", text: t("conn.brainOn"), sub: desk };
  if (a.service === "google") return { cls: "ok-t", text: t("google.connected"), sub: desk };
  return { cls: "ok-t", text: t("conn.ready"), sub: desk };
}

/** The console opens the consent page in the system browser; when it could not (no opener, a server), the
 *  link is shown to open or copy, never a message saying it opened (#14). The result comes back as a toast. */
async function login(kind: "google" | "brain", account: string): Promise<void> {
  const r = await startLogin(kind, account);
  if (!r.ok || !r.url) return toast(r.message ?? "", true);
  if (r.opened) return toast(t(kind === "google" ? "google.finish" : "brain.finish"));
  const url = r.url;
  openDrawer(t("login.manual.h"), () => <ManualLink url={url} />);
}

function AccRow({ a, view, reload }: { a: Account; view: AccountsView; reload: () => void }) {
  const st = accState(a);
  const who = a.service === "google" && a.email ? a.email : a.url ? a.url.replace(/^https?:\/\//, "").replace(/\/$/, "") : "";
  return (
    <div class="acc-row">
      <div class="acc-who" title={a.note || undefined}>
        <b>{a.name}</b>
        {who && <small>{who}</small>}
      </div>
      <div class="chips"><Chips ps={a.profiles} /></div>
      <div class="acc-state">
        <span class={st.cls}>{st.text}</span>
        {st.sub && <small>{st.sub.code ? <code>{st.sub.text}</code> : st.sub.text}</small>}
      </div>
      <div class="acts">
        {a.service === "google" && view.google.client && (
          <button type="button" class="btn sm" onClick={() => login("google", a.name)}>
            {t(a.hasSecret ? "google.reconnect" : "google.connect")}
          </button>
        )}
        {a.service === "brain" && a.url && view.vault.state === "ok" && (
          <button type="button" class="btn sm" onClick={() => login("brain", a.name)}>{t("brain.login")}</button>
        )}
        <button type="button" class="btn ghost sm" onClick={() => openAccountForm(view, a, reload)}>{t("conn.edit")}</button>
      </div>
    </div>
  );
}

function ServerRow({ sv }: { sv: Server }) {
  const desk = desktopNote(sv);
  const pending = sv.pending.length;
  return (
    <div class="acc-row">
      <div class="acc-who"><span class="sub">{t("conn.noAccount")}</span></div>
      <div class="chips"><Chips ps={sv.profiles} /></div>
      <div class="acc-state">
        <span class={pending ? "warn-t" : "ok-t"}>
          {pending ? t("conn.pending", { p: sv.pending.join(", ") }) : t("conn.ready")}
        </span>
        {desk && <small>{desk.text}</small>}
      </div>
      <div class="acts" />
    </div>
  );
}

function Svc({ service, title, children }: { service: string; title?: string; children: ComponentChildren }) {
  const desc = tk(`svc.${service}`);
  return (
    <div class="svc">
      <div class="svc-h">
        <Logo service={service} />
        <b>{title ?? svcName(service)}</b>
        {desc !== `svc.${service}` && <span class="sub">{desc}</span>}
      </div>
      {children}
    </div>
  );
}

/** The service blocks, sorted by name; `accs` and `servers` are already filtered by profile. */
export function Services({ view, accs, servers, reload }: {
  view: AccountsView;
  accs: Account[];
  servers: Server[];
  reload: () => void;
}) {
  const bySvc = new Map<string, Account[]>();
  for (const a of accs) if (a.service !== "brain") bySvc.set(a.service, [...bySvc.get(a.service) ?? [], a]);
  const blocks = [
    ...[...bySvc].map(([svc, list]) => ({
      name: svcName(svc),
      el: (
        <Svc key={svc} service={svc}>
          {list.map((a) => <AccRow key={a.name} a={a} view={view} reload={reload} />)}
        </Svc>
      ),
    })),
    ...servers.map((sv) => ({
      name: svcName(sv.name),
      el: <Svc key={`server/${sv.name}`} service={sv.name}><ServerRow sv={sv} /></Svc>,
    })),
  ].sort((x, y) => x.name.localeCompare(y.name));
  return blocks.length ? <>{blocks.map((b) => b.el)}</> : <p class="sub">{t("acc.none")}</p>;
}

/** Brain and tasks: Agents Multi's own, apart at the bottom. */
export function Ours({ view, accs, reload }: { view: AccountsView; accs: Account[]; reload: () => void }) {
  const brain = accs.filter((a) => a.service === "brain");
  if (!brain.length) return <p class="sub">{t("conn.noBrain")}</p>;
  return (
    <>
      <Svc service="brain" title={t("conn.brain")}>
        {brain.map((a) => <AccRow key={a.name} a={a} view={view} reload={reload} />)}
      </Svc>
      <PairCard reload={reload} />
      <AddServerCard />
    </>
  );
}

/** The vault speaks up only when something is to be done on this machine, and does it here: created
 *  (its recovery code shown once) or opened with the recovery code, as the first-run wizard does. */
export function VaultCard({ v, reload }: { v: AccountsView["vault"]; reload: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [given, setGiven] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const msg: [string, Key] | null = code
    ? ["update", "vault.created"]
    : v.state === "wrong-key"
    ? ["fail", "vault.wrongKey"]
    : v.state === "no-key"
    ? ["update", v.initialised ? "vault.pair" : "vault.init"]
    : v.conflicts
    ? ["update", "vault.conflicts"]
    : null;
  if (!msg) return null;
  const op = async (body: Record<string, string>) => {
    setBusy(true);
    const r = await post<{ ok: boolean; message?: string; code?: string }>("/api/vault", body)
      .catch((e: Error) => ({ ok: false, message: e.message, code: undefined }));
    setBusy(false);
    if (!r.ok) return toast(r.message ?? "", true);
    if (r.code) return setCode(r.code);
    toast(t("vault.paired"));
    reload();
  };
  const pairing = !code && (v.state === "wrong-key" || (v.state === "no-key" && v.initialised));
  return (
    <div class={`status-card ${msg[0]}`} style={{ marginTop: "20px" }}>
      <i />
      <div>
        <b>{t("vault.title")}</b>
        <div class="sub">{t(msg[1], { n: v.conflicts })}</div>
        <div class="sub"><code>{v.dir}</code></div>
        {code && (
          <p>
            <code>{code}</code>{" "}
            <button
              type="button"
              class="btn sm"
              onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {})}
            >
              {t(copied ? "su.vault.copied" : "su.vault.copy")}
            </button>{" "}
            <button type="button" class="btn sm" onClick={() => { setCode(null); reload(); }}>{t("su.vault.saved")}</button>
          </p>
        )}
        {!code && v.state === "no-key" && !v.initialised && (
          <p><button type="button" class="btn sm" disabled={busy} onClick={() => void op({ mode: "init" })}>{t("su.vault.create")}</button></p>
        )}
        {pairing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void op({ mode: "pair", code: given.trim() });
            }}
          >
            <input
              type="password"
              autocomplete="off"
              placeholder={t("su.vault.code")}
              value={given}
              onInput={(e) => setGiven(e.currentTarget.value)}
            />{" "}
            <button type="submit" class="btn sm" disabled={busy || !given.trim()}>{t("su.vault.pair")}</button>
          </form>
        )}
      </div>
    </div>
  );
}
