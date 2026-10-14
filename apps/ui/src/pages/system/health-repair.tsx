// health-repair.tsx — what a check offers to fix it: the «Repair» button when the doctor gave it steps,
// else its fix as a button when it maps to an allowlisted action, else the command as text. The repair
// drawer walks the steps: numbered, with the live output of the running one, and a re-run of the check
// at the end. A «close» step lists the Claudes in the way (the server's reading, close-claude.ts) and
// closes them on request, or waits for the person to and checks again. The steps come from the doctor;
// the server checks every action again.

import { useEffect, useRef, useState } from "preact/hooks";
import { api, type Blocker, type Check, post, type RepairStep } from "../../api.ts";
import { loadStatus, status } from "../../state.ts";
import { type Key, t } from "../../i18n.ts";
import { go } from "../../router.ts";
import { short } from "../../lib/format.ts";
import { FIX_ACTIONS, openDrawer, runAction, runJob, toast } from "../../lib/ui.tsx";
import { closeStep } from "./api.ts";
import { BlockerList, reopenProfile } from "./updates-close.tsx";

/** Actions that only read or check: a repair made of these starts without asking. */
const READ_ONLY_ACTIONS = ["doctor", "update-check", "mcp-check", "install-dry", "sync-fetch"];

type StepState = "todo" | "running" | "waiting" | "done" | "failed";

/** Where a fix that names a page of the console («console › Connections …») goes. */
const PAGES: [RegExp, string, Key][] = [
  [/console (›|→) System › Permissions/, "system/permissions", "sys.permissions"],
  [/console (›|→) Plugins/, "system/plugins", "sys.plugins"],
  [/console (›|→) Connections/, "connections", "nav.connections"],
];

/** A fix line is a shell command. When it maps to an allowlisted action there is a button; when it
 *  names a page of the console, a button that goes there; otherwise it is text to copy, because running
 *  arbitrary strings from here would turn the console into a remote shell. */
export function ActionButton({ fix }: { fix: string }) {
  const act = FIX_ACTIONS[fix.trim()];
  const page = PAGES.find(([re]) => re.test(fix));
  return act
    ? <button type="button" class="fix" onClick={() => runAction(act)}>{fix}</button>
    : page
    ? (
      <button type="button" class="fix" title={fix} onClick={() => go(page[1])}>
        {t("rep.open", { p: t(page[2]) })}
      </button>
    )
    : (
      <code
        class="fix"
        style={{ cursor: "text", background: "none", borderColor: "var(--line)", color: "var(--fg-faint)" }}
        title={fix}
      >
        {short(fix, 40)}
      </code>
    );
}

/** What a check offers: its repair when it has steps, else the fix as before. */
export function FixControl({ c }: { c: Pick<Check, "id" | "fix" | "repair"> }) {
  if (c.repair?.length) {
    return <button type="button" class="fix" onClick={() => openRepair(c.id)}>{t("rep.btn")}</button>;
  }
  return c.fix ? <ActionButton fix={c.fix} /> : null;
}

function openRepair(id: string): void {
  const check = (status.value?.doctor ?? []).find((c) => c.id === id);
  if (!check?.repair?.length) return;
  openSteps(t("rep.title"), check.msg, check.repair, { id });
}

/** The steps drawer, for a check's repair (`id`: its verify step re-runs that check) or for an action
 *  that needs Claude closed first; `auto` starts it at once. */
export function openSteps(title: string, msg: string, steps: RepairStep[], o: { id?: string; auto?: boolean } = {}) {
  openDrawer(title, () => <Repair id={o.id ?? null} msg={msg} steps={steps} auto={o.auto} />);
}

/** Claude Code's sign-in for a profile, in a terminal the server opens. */
const openLogin = (profile: string) =>
  post<{ ok: boolean; message?: string }>("/api/login", { profile }).catch((e: Error) => ({ ok: false, message: e.message }));

const action = (name: string, cmd: string): RepairStep => ({ kind: "action", action: name, cmd });

/** «Apply» the MCP registry: the launch configs are rebuilt and Claude picks them up at its next start,
 *  so nothing has to be closed. */
export function syncMcp(): Promise<void> {
  return runAction("mcp-sync");
}

/** Claude Desktop back to the previous version, every Desktop closed first. */
export function rollbackDesktop(): void {
  openSteps(t("up.rollback"), t("rep.rollbackMsg"), [
    { kind: "close", for: "desktop", text: "Close every Claude Desktop" },
    action("rollback-desktop", "agents update --rollback --desktop"),
  ], { auto: true });
}

/** A repair's run, for the drawer: the steps' state, the running step's output, the cause of a
 *  failure, and the controls. */
function useRepair(id: string | null, steps: RepairStep[]) {
  const [state, setState] = useState<StepState[]>(() => steps.map(() => "todo"));
  const [running, setRunning] = useState(false);
  const [cause, setCause] = useState("");
  const [out, setOut] = useState("");
  const jobId = useRef<string | null>(null);
  /** Resolves the step waiting on the person: true goes on, false is «Cancel». */
  const userGo = useRef<((go: boolean) => void) | null>(null);
  const cur = useRef<StepState[]>(state); // the steps' state as the loop sees it
  const outEl = useRef<HTMLPreElement>(null);
  /** The Claudes a «close» step waits on; `stuck` once a TERM left some of them open. */
  const [holders, setHolders] = useState<{ list: Blocker[]; stuck: boolean } | null>(null);
  /** Desktop profiles the repair closed, to open again at the end. */
  const [reopen, setReopen] = useState<string[]>([]);

  const mark = (i: number, s: StepState) => {
    cur.current = cur.current.map((x, j) => (j === i ? s : x));
    setState(cur.current);
  };

  /** true when the check passes at the end */
  const run = async (): Promise<boolean> => {
    setRunning(true);
    setCause("");
    let text = "";
    for (let i = 0; i < steps.length; i++) {
      if (cur.current[i] === "done") continue;
      const s = steps[i];
      const fail = (why: string) => {
        mark(i, "failed");
        setCause(why);
        return false;
      };
      mark(i, "running");
      text = "";
      setOut("");
      if (s.kind === "action") {
        const r = await runJob(s.action, s.args ?? {}, (o) => {
          text += o;
          setOut(text);
          requestAnimationFrame(() => {
            if (outEl.current) outEl.current.scrollTop = outEl.current.scrollHeight;
          });
        }, (j) => jobId.current = j).catch((e: Error) => ({ error: e.message }));
        jobId.current = null;
        if ("error" in r) return fail(r.error === "lost" ? t("rep.lost") : r.error);
        if (r.cancelled) return fail(t("rep.cancelled"));
        if (r.code) return fail(text.trim().split("\n").filter(Boolean).pop() ?? t("rep.exit", { c: r.code }));
      } else if (s.kind === "login") {
        const r = await openLogin(s.profile);
        if (!r.ok) return fail(r.message ?? t("rep.loginFailed"));
        mark(i, "waiting");
        const go = await new Promise<boolean>((res) => userGo.current = res);
        userGo.current = null;
        if (!go) return fail(t("rep.cancelled"));
      } else if (s.kind === "close") {
        const p = await api.closePlan(s.for).catch((e: Error) => e);
        if (p instanceof Error) return fail(p.message);
        if (p.offer) {
          mark(i, "waiting");
          setHolders({ list: p.blockers, stuck: false });
          const go = await new Promise<boolean>((res) => userGo.current = res);
          userGo.current = null;
          setHolders(null);
          if (!go) return fail(t("rep.cancelled"));
        }
      } else if (id) {
        await loadStatus(true);
        const now = status.value?.doctor.find((c) => c.id === id);
        if (now && now.status !== "ok") return fail(t("rep.still", { msg: now.msg }));
      }
      mark(i, "done");
    }
    toast(t(id ? "rep.fixed" : "rep.ok"));
    if (!id) await loadStatus().catch(() => {});
    return true;
  };

  /** Starts (or retries) the repair, asking first when a step changes something. */
  const start = async (ask = true): Promise<boolean> => {
    if (running) return false;
    const changes = steps.filter((s) => s.kind === "action" && !READ_ONLY_ACTIONS.includes(s.action));
    if (ask && changes.length && !confirm(t("rep.confirm", { cmds: changes.map((s) => (s as { cmd: string }).cmd).join("\n") }))) {
      return false;
    }
    cur.current = cur.current.map((s) => s === "failed" ? "todo" : s);
    setState(cur.current);
    try {
      return await run();
    } finally {
      setRunning(false);
    }
  };

  const cancel = async () => {
    userGo.current?.(false);
    if (jobId.current) await api.jobCancel(jobId.current);
  };

  /** The step whose turn it is, when it is a «close» one. */
  const closing = () => {
    const i = cur.current.indexOf("waiting");
    const s = steps[i];
    return s?.kind === "close" ? s : null;
  };

  /** «Done» on a step: a «close» one moves on only once the server sees nothing left open. */
  const userDone = async () => {
    const s = closing();
    if (!s) return userGo.current?.(true);
    const p = await api.closePlan(s.for).catch(() => null);
    if (p?.offer) {
      setHolders({ list: p.blockers, stuck: false });
      return toast(t("rep.stillOpen"), true);
    }
    userGo.current?.(true);
  };

  /** Closes the listed Claudes: TERM, or KILL when the person asks again after a TERM left some open. */
  const closeThem = async (step: "term" | "kill") => {
    const s = closing();
    if (!s) return;
    const r = await closeStep(step, s.for).catch((e: Error) => ({ ok: false, message: e.message, reopen: [], remaining: [] }));
    if (!r.ok) return toast(r.message ?? "", true);
    setReopen((x) => [...new Set([...x, ...r.reopen])]);
    if (r.remaining.length) return setHolders({ list: r.remaining, stuck: true });
    userGo.current?.(true);
  };

  return { state, running, cause, out, outEl, start, cancel, userDone, holders, closeThem, reopen };
}

function Repair({ id, msg, steps, auto }: { id: string | null; msg: string; steps: RepairStep[]; auto?: boolean }) {
  const { state, running, cause, out, outEl, start, cancel, userDone, holders, closeThem, reopen } = useRepair(id, steps);
  const [reopened, setReopened] = useState<string[]>([]);
  // an action the person just asked for: no second question, unless it is one that changes things
  // they did not name (a rollback asks, through its own steps' confirm)
  useEffect(() => {
    if (auto) void start(steps.some((s) => s.kind === "action" && s.action.startsWith("rollback")));
  }, []);
  const go = !running && (state.includes("failed") || state.every((s) => s === "todo"));
  const manual = steps.filter((s) => s.kind !== "verify").map((s) => s.kind === "action" ? s.cmd : s.text).join("\n");

  return (
    <div class="rep">
      <p class="rep-msg">{msg}</p>
      <ol class="rep-steps">
        {steps.map((s, i) => (
          <li key={i} class={`rep-${state[i]}`}>
            <span class="rep-st">{t(`rep.${state[i]}`)}</span>{" "}
            {s.kind === "action"
              ? <code>{s.cmd}</code>
              : s.kind === "login"
              ? t("rep.loginStep", { p: s.profile })
              : s.kind === "close"
              ? (s.for === "install"
                ? t("rep.closeAll")
                : t("rep.closeDesktop", { p: s.for.slice("desktop:".length) || t("rep.every") }))
              : t("rep.verifyStep")}
            {state[i] === "waiting" && s.kind === "login" && (
              <div class="rep-close">
                <p class="sub">{t("rep.loginWait")}</p>
                <p>
                  <button type="button" class="btn sm" onClick={() => void openLogin(s.profile)}>{t("rep.loginAgain")}</button>{" "}
                  <button type="button" class="btn sm" onClick={() => void userDone()}>{t("rep.userDone")}</button>
                </p>
              </div>
            )}
            {state[i] === "waiting" && s.kind === "close" && holders && (
              <div class="rep-close">
                <p class="sub">{t(holders.stuck ? "cc.stuck" : s.for === "install" ? "cc.intro" : "rep.closeIntroDesktop")}</p>
                <BlockerList list={holders.list} />
                {holders.stuck && <p class="sub">{t("cc.forceWarn")}</p>}
                {holders.list.every((b) => b.protected) && <p class="sub">{t("rep.onlyProtected")}</p>}
                <p>
                  {holders.list.some((b) => !b.protected) && (
                    <button type="button" class="btn sm" onClick={() => void closeThem(holders.stuck ? "kill" : "term")}>
                      {t(holders.stuck ? "rep.force" : "rep.closeThem")}
                    </button>
                  )}{" "}
                  <button type="button" class="btn sm" onClick={() => void userDone()}>{t("rep.closedByHand")}</button>
                </p>
              </div>
            )}
          </li>
        ))}
      </ol>
      {cause && <p class="rep-cause">{cause}</p>}
      {!running && reopen.length > 0 && (
        <p>
          {reopen.map((p) => (
            <button
              type="button"
              class="btn sm"
              key={p}
              disabled={reopened.includes(p)}
              onClick={() => {
                setReopened((x) => [...x, p]);
                void reopenProfile(p);
              }}
            >
              {t("cc.reopen", { p })}
            </button>
          ))}
        </p>
      )}
      {out && <pre class="out rep-out" ref={outEl}>{out}</pre>}
      <p>
        {running
          ? <button type="button" class="btn sm" onClick={cancel}>{t("rep.cancel")}</button>
          : go
          ? <button type="button" class="btn" onClick={() => void start()}>{t("rep.start")}</button>
          : null}
      </p>
      <details>
        <summary>{t("rep.manual")}</summary>
        <pre class="out">{manual}</pre>
      </details>
    </div>
  );
}

