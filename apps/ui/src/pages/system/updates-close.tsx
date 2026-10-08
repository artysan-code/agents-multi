// updates-close.tsx — «Close Claude and update»: the server lists who holds the install (it alone knows
// the PIDs), the person confirms, then TERM; KILL only as a second, explicit confirmation; then the
// install. A screen like the update's (lib/screen.css), opened from the Updates tab, the update screen
// and the buttons that stand for «Update now» while only the install is left.

import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import { get, post, type Result } from "../../api.ts";
import { loadStatus } from "../../state.ts";
import { t } from "../../i18n.ts";
import { Pf, toast, toastErr } from "../../lib/ui.tsx";
import { request } from "../../router.ts";
import { sys } from "../../shell/sysstate.ts";

interface Blocker {
  key: string;
  pid: number;
  profile: string;
  embedded: boolean;
  busy: boolean | null;
  ageSec: number | null;
  protected: boolean;
}
interface Plan {
  offer: boolean;
  /** the build or commit an install is waiting with; null when none is */
  pending: string | null;
  blockers: Blocker[];
}
interface StepResult extends Result {
  reopen: string[];
  remaining: Blocker[];
}
interface Settled {
  code: number;
  ms: number;
  output?: string;
}

function age(s: number | null): string {
  if (s == null) return "";
  const a = s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return t("cc.age", { a });
}

function BlockerList({ list }: { list: Blocker[] }) {
  return (
    <ul class="cc-list">
      {list.map((b) => (
        <li key={`${b.key}:${b.pid}`}>
          <code>{b.key}</code> pid {b.pid} <Pf name={b.profile} />{" "}
          <span class="sub">
            {[
              b.embedded ? t("cc.embedded") : null,
              b.busy === null ? null : t(b.busy ? "cc.busy" : "cc.idle"),
              age(b.ageSec),
              b.protected ? t("cc.protected") : null,
            ].filter(Boolean).join(" · ")}
          </span>
        </li>
      ))}
    </ul>
  );
}

type Phase =
  | { k: "plan" }
  | { k: "text"; msg: string }
  | { k: "stuck"; remaining: Blocker[] }
  | { k: "done"; out: string };

/** The install that waited, run now: what the screen does once every Claude is closed. */
async function runSettle(): Promise<Settled> {
  const r = await post<Settled>("/api/action", { action: "settle-install", opts: [] }).catch((e: Error) => (
    { code: 1, ms: 0, output: e.message }
  ));
  const s = (r.ms / 1000).toFixed(1);
  toast(
    r.code ? t("act.doneExit", { a: "settle-install", c: r.code, s }) : t("act.done", { a: "settle-install", s }),
    r.code !== 0,
  );
  await loadStatus().catch(() => {});
  return r;
}

function CloseClaude({ plan }: { plan: Plan }) {
  const [phase, setPhase] = useState<Phase>({ k: "plan" });
  const [reopen, setReopen] = useState<string[]>([]);
  const [reopened, setReopened] = useState<string[]>([]);
  const todo = plan.blockers.filter((b) => !b.protected);

  const settle = async (profiles: string[]) => {
    setPhase({ k: "text", msg: t("cc.updating") });
    const r = await runSettle();
    setPhase({ k: "done", out: r.output || t("act.noOutput") });
    setReopen(profiles);
  };

  const step = async (kind: "term" | "kill") => {
    setPhase({ k: "text", msg: t("cc.closing") });
    const r = await post<StepResult>("/api/close-claude", { step: kind }).catch((e: Error) => (
      { ok: false, message: e.message } as StepResult
    ));
    if (!r.ok) {
      setPhase({ k: "text", msg: r.message ?? "" });
      return toast(r.message ?? "", true);
    }
    const profiles = [...new Set([...reopen, ...r.reopen])];
    setReopen(profiles);
    if (r.remaining.length) return setPhase({ k: "stuck", remaining: r.remaining });
    await settle(profiles);
  };

  const reopenOne = async (p: string) => {
    setReopened((x) => [...x, p]);
    const r = await post<{ started?: string[] }>("/api/close-claude", { step: "reopen", profiles: [p] }).catch(() => null);
    toast(r ? t("cc.reopened", { p: (r.started ?? []).join(", ") }) : t("uw.reopenFailed"), !r);
  };

  if (phase.k === "text") return <p>{phase.msg}</p>;
  if (phase.k === "stuck") {
    return (
      <>
        <p>{t("cc.stuck")}</p>
        <BlockerList list={phase.remaining} />
        <p class="sub">{t("cc.forceWarn")}</p>
        <div class="uw-go">
          <button type="button" class="bt" onClick={() => void step("kill")}>{t("cc.force")}</button>
          <button type="button" class="bt pri" onClick={() => void step("term")}>{t("cc.retry")}</button>
        </div>
      </>
    );
  }
  if (phase.k === "done") {
    return (
      <>
        <pre class="out">{phase.out}</pre>
        {reopen.length > 0 && (
          <div class="uw-go">
            {reopen.map((p) => (
              <button type="button" class="bt" key={p} disabled={reopened.includes(p)} onClick={() => void reopenOne(p)}>
                {t("cc.reopen", { p })}
              </button>
            ))}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <p>{t("cc.intro")}</p>
      <BlockerList list={plan.blockers} />
      {todo.length
        ? (
          <div class="uw-go">
            <button type="button" class="bt pri" onClick={() => void step("term")}>{t("cc.go")}</button>
          </div>
        )
        : <p class="sub">{t("cc.onlyProtected")}</p>}
    </>
  );
}

const open = signal<{ plan: Plan; at: number } | null>(null);

/** Asks the server who holds the install, and opens the screen with the plan. With nothing left to close
 *  (every Claude closed by hand since) the install runs at once; with none waiting, it says so. */
export async function openCloseClaude(): Promise<void> {
  let plan: Plan;
  try {
    plan = await get<Plan>("/api/close-claude");
  } catch (e) {
    return toastErr(e);
  }
  if (!plan.offer) {
    if (plan.pending) return void await runSettle();
    return toast(t("cc.none"));
  }
  open.value = { plan, at: Date.now() };
}

/** The screen, drawn by the shell beside the update screen. */
export function CloseClaudeHost() {
  const o = open.value;
  if (!o) return null;
  const close = () => open.value = null;
  return (
    <div class="uw-screen" role="dialog" aria-modal="true" aria-label={t("cc.btn")}>
      <div class="uw-card">
        <button type="button" class="ib uw-x" title={t("close")} aria-label={t("close")} onClick={close}>
          <svg viewBox="0 0 24 24">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <h2>{t("cc.btn")}</h2>
        <CloseClaude key={o.at} plan={o.plan} />
      </div>
    </div>
  );
}

/** «Update now», or «Close Claude and update» when all that is left is the install waiting for every
 *  Claude to be closed: the update is already here, and the wizard would only say so. */
export function UpdateNow({ cls, auto }: { cls: string; auto?: boolean }) {
  const settle = sys.value.upWord === "pill.settle";
  const go = () => settle ? void openCloseClaude() : request("update.wizard", undefined, auto ? "auto" : undefined);
  return <button type="button" class={cls} onClick={go}>{t(settle ? "cc.btn" : "up.now")}</button>;
}
