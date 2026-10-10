// health-repair.tsx — what a check offers to fix it: the «Repair» button when the doctor gave it steps,
// else its fix as a button when it maps to an allowlisted action, else the command as text. The repair
// drawer walks the steps: numbered, with the live output of the running one, and a re-run of the check
// at the end. The steps come from the doctor; the server checks every action again.

import { useRef, useState } from "preact/hooks";
import { post, type Check, type RepairStep } from "../../api.ts";
import { loadStatus, status } from "../../state.ts";
import { t } from "../../i18n.ts";
import { short } from "../../lib/format.ts";
import { FIX_ACTIONS, openDrawer, runAction, runJob, toast } from "../../lib/ui.tsx";

/** Actions that only read or check: a repair made of these starts without asking. */
const READ_ONLY_ACTIONS = ["doctor", "update-check", "mcp-check", "install-dry", "sync-fetch"];

type StepState = "todo" | "running" | "waiting" | "done" | "failed";

/** A fix line is a shell command. When it maps to an allowlisted action there is a button; otherwise
 *  it is text to copy, because running arbitrary strings from here would turn the console into a
 *  remote shell. */
export function ActionButton({ fix }: { fix: string }) {
  const act = FIX_ACTIONS[fix.trim()];
  return act
    ? <button type="button" class="fix" onClick={() => runAction(act)}>{fix}</button>
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
  openDrawer(t("rep.title"), () => <Repair id={id} check={check} steps={check.repair!} />);
}

/** A repair's run, for the drawer and for Today's system card: the steps' state, the running step's
 *  output, the cause of a failure, and the controls. */
function useRepair(id: string, steps: RepairStep[]) {
  const [state, setState] = useState<StepState[]>(() => steps.map(() => "todo"));
  const [running, setRunning] = useState(false);
  const [cause, setCause] = useState("");
  const [out, setOut] = useState("");
  const jobId = useRef<string | null>(null);
  const userGo = useRef<(() => void) | null>(null);
  const cur = useRef<StepState[]>(state); // the steps' state as the loop sees it
  const outEl = useRef<HTMLPreElement>(null);

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
      } else if (s.kind === "user") {
        mark(i, "waiting");
        await new Promise<void>((res) => userGo.current = res);
        userGo.current = null;
      } else {
        await loadStatus(true);
        const now = status.value?.doctor.find((c) => c.id === id);
        if (now && now.status !== "ok") return fail(t("rep.still", { msg: now.msg }));
      }
      mark(i, "done");
    }
    toast(t("rep.fixed"));
    return true;
  };

  /** Starts (or retries) the repair, asking first when a step changes something. */
  const start = async (): Promise<boolean> => {
    if (running) return false;
    const changes = steps.filter((s) => s.kind === "action" && !READ_ONLY_ACTIONS.includes(s.action));
    if (changes.length && !confirm(t("rep.confirm", { cmds: changes.map((s) => (s as { cmd: string }).cmd).join("\n") }))) {
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
    if (jobId.current) await post("/api/job/cancel", { id: jobId.current }).catch(() => {});
  };

  return { state, running, cause, out, outEl, start, cancel, userDone: () => userGo.current?.() };
}

function Repair({ id, check, steps }: { id: string; check: Check; steps: RepairStep[] }) {
  const { state, running, cause, out, outEl, start, cancel, userDone } = useRepair(id, steps);
  const go = !running && (state.includes("failed") || state.every((s) => s === "todo"));
  const manual = steps.filter((s) => s.kind !== "verify").map((s) => s.kind === "action" ? s.cmd : s.text).join("\n");

  return (
    <div class="rep">
      <p class="rep-msg">{check.msg}</p>
      <ol class="rep-steps">
        {steps.map((s, i) => (
          <li key={i} class={`rep-${state[i]}`}>
            <span class="rep-st">{t(`rep.${state[i]}`)}</span>{" "}
            {s.kind === "action" ? <code>{s.cmd}</code> : s.kind === "user" ? s.text : t("rep.verifyStep")}
            {state[i] === "waiting" && (
              <>{" "}<button type="button" class="btn sm" onClick={userDone}>{t("rep.userDone")}</button></>
            )}
          </li>
        ))}
      </ol>
      {cause && <p class="rep-cause">{cause}</p>}
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

