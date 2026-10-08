// overview.tsx — System › Overview: one card per part of the setup, its state in a line or two, what
// to do when there is something, and a link to the tab with the detail.

import type { ComponentChildren } from "preact";
import { status } from "../../state.ts";
import { lang, t } from "../../i18n.ts";
import type { Check } from "../../api.ts";
import { ActionButton, FixControl } from "./health-repair.tsx";
import { profilesOf } from "./profiles-types.ts";
import { UpdateNow } from "./updates-close.tsx";

const SYM = { ok: "✓", warn: "!", fail: "✕" } as const;

function Card({ title, href, cls = "", children }: { title: string; href: string; cls?: string; children: ComponentChildren }) {
  return (
    <section class={`ov-card ${cls}`}>
      <div class="ov-h">
        <h3>{title}</h3>
        <a class="pane-link" href={href}>{t("ov.open")}</a>
      </div>
      {children}
    </section>
  );
}

function Line({ st, children, extra }: { st: Check["status"]; children: ComponentChildren; extra?: ComponentChildren }) {
  return (
    <div class="ov-line">
      <span class={`ic ${st}`}>{SYM[st]}</span>
      <div>{children}</div>
      {extra}
    </div>
  );
}

interface BrainView {
  url: string | null;
  lastCopy?: { checked: string; verified: boolean };
}

const when = (iso: string): string =>
  new Date(iso).toLocaleString(lang(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function Overview() {
  const s = status.value;
  if (!s) return <div class="sub-view" />;
  const checks = s.doctor ?? [];
  const byId = (id: string) => checks.find((c) => c.id === id);

  // health: the problems themselves, the passing count in one line
  const todo = checks.filter((c) => c.status !== "ok").sort((a, b) =>
    (a.status === "fail" ? -1 : 0) - (b.status === "fail" ? -1 : 0)
  );
  const health = todo.length
    ? (
      <>
        {todo.slice(0, 5).map((c) => (
          <Line key={c.id} st={c.status} extra={<FixControl c={c} />}>{c.msg}</Line>
        ))}
        {todo.length > 5 && <div class="sub">{t("ov.more", { n: todo.length - 5 })}</div>}
      </>
    )
    : <Line st="ok">{t("health.allGood", { n: checks.length })}</Line>;

  // updates: one line per component, the same words as the Updates tab
  const m = s.machine, u = s.update ?? {}, r = s.repo;
  const upLine = (name: string, v: string | null, pending: string | null) => (
    <Line key={name} st={pending ? "warn" : "ok"}>
      <b>{name}</b> <code>{v ?? "—"}</code> <span class="sub">{pending ?? t("ov.upToDate")}</span>
    </Line>
  );
  const updates = (
    <>
      {upLine("Claude Code", m.cliVersion, u.cli?.latest && u.cli.latest !== m.cliVersion ? t("ov.upNext", { v: u.cli.latest }) : null)}
      {m.desktopVersion &&
        upLine("Claude Desktop", m.desktopVersion, m.desktopStaged ? t("ov.upStaged", { v: m.desktopStaged }) : null)}
      {r?.isRepo && upLine("agents-multi", (r.head ?? "").split(" ")[0], r.behind ? t("ov.upBehind", { n: r.behind }) : null)}
      <div class="ov-acts">
        <UpdateNow cls="btn sm" />
      </div>
    </>
  );

  // brain: whether this machine reaches it, and the last copy kept here
  const b = s.brain as BrainView | null;
  const tok = byId("brain.token"), store = byId("tasks.store");
  const brain = !b
    ? <p class="sub">{t("ov.noBrain")}</p>
    : (
      <>
        <Line st={tok?.status ?? "warn"} extra={tok?.fix ? <ActionButton fix={tok.fix} /> : undefined}>
          {tok?.status === "ok" ? t("ov.brain.on", { u: (b.url ?? "").replace(/^https?:\/\//, "") }) : tok?.msg ?? t("ov.brainOff")}
        </Line>
        <Line st={store?.status ?? "warn"}>{t(store?.status === "ok" ? "ov.tasks.on" : "ov.tasks.off")}</Line>
        {b.lastCopy
          ? (
            <Line st={b.lastCopy.verified ? "ok" : "warn"}>
              {t(b.lastCopy.verified ? "ov.copy" : "ov.copyUnchecked", { d: when(b.lastCopy.checked) })}
            </Line>
          )
          : <Line st="warn">{t("ov.noCopy")}</Line>}
      </>
    );

  // profiles: who each one is and what is open now
  const live = new Set(s.running.cli.map((c) => c.profile));
  const deskOpen = new Set(s.running.desktop.map((d) => d.variant));
  const profiles = profilesOf(s).map(([n, p]) => (
    <div class="ov-prof" key={n}>
      <span class={`dot${live.has(n) || deskOpen.has(n) ? " active" : ""}`} />
      <b>{n}</b>
      <span class="sub">{p.account ?? t("profile.notSignedIn")}</span>
      <code>{p.manifest.command ?? `claude-${n}`}</code>
      <span class="sub">
        {[
          live.has(n) ? t("ov.cliOpen", { n: s.running.cli.filter((c) => c.profile === n).length }) : null,
          deskOpen.has(n) ? t("ov.deskOpen") : null,
        ].filter(Boolean).join(" · ")}
      </span>
    </div>
  ));

  return (
    <div class="sub-view">
      <div class="ov-grid">
        <Card
          title={t("sys.health")}
          href="#system/health"
          cls={todo.some((c) => c.status === "fail") ? "fail" : todo.length ? "warn" : ""}
        >
          {health}
        </Card>
        <Card title={t("sys.updates")} href="#system/updates">{updates}</Card>
        <Card title={t("ov.brainTitle")} href="#connections">{brain}</Card>
        <Card title={t("sys.profiles")} href="#system/profiles">{profiles}</Card>
      </div>
    </div>
  );
}
