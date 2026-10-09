// steps.tsx — a run's steps, one row each with its mark, and the bar of the one running (styles in
// screen.css): the update screen (pages/system/wizard.tsx) and the first-run wizard (pages/setup/) draw
// their progress with it. And `RunMark`, the update screen's head: the logo in a ring that fills as the
// steps go, which closes green with the logo's five drops when the run ends well.

import mark from "../assets/mark.svg";

export type StepState = "todo" | "running" | "done" | "failed" | "skipped";

export interface StepRow {
  key: string;
  label: string;
  state: StepState;
  /** on the right: a version, a percentage, «not needed» */
  detail?: string;
  /** the bar's fill while running, 0–100; none is an indeterminate bar */
  pct?: number | null;
}

const Tick = () => (
  <svg viewBox="0 0 16 16" class="uw-tick">
    <path d="M3.5 8.5l3 3 6-7" />
  </svg>
);

export function StepRows({ rows }: { rows: StepRow[] }) {
  return (
    <ol class="uw-steps">
      {rows.map(({ key, label, state: st, detail, pct }, i) => (
        <li key={key} class={`uw-${st}`} style={{ "--i": i }}>
          <span class="uw-ic">
            {st === "running"
              ? <span class="spin2" />
              : st === "done"
              ? <Tick />
              : st === "failed"
              ? "!"
              : st === "skipped"
              ? "–"
              : ""}
          </span>
          <span class="uw-n">{label}</span>
          <span class="uw-d">{detail ?? ""}</span>
          {(st === "running" || st === "failed") && (
            <span class="uw-bar">
              <i
                class={st === "running" && pct == null ? "ind" : ""}
                style={{
                  width: pct != null ? `${pct}%` : st === "running" ? "40%" : "100%",
                }}
              />
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** How far a run is, 0–1: the steps behind it, and half of the one running. */
export const runShare = (states: StepState[]): number =>
  states.length
    ? states.reduce(
      (n, s) => n + (s === "done" || s === "skipped" ? 1 : s === "running" ? .5 : 0),
      0,
    ) / states.length
    : 0;

const R = 28, C = 2 * Math.PI * R;

export function RunMark(
  { share, state }: { share: number; state: "idle" | "on" | "ok" | "bad" },
) {
  const fill = state === "ok" ? 1 : share;
  return (
    <div class={`rm rm-${state}`} aria-hidden="true">
      <svg viewBox="0 0 64 64" class="rm-ring">
        <circle class="rm-track" cx="32" cy="32" r={R} />
        <circle
          class="rm-fill"
          cx="32"
          cy="32"
          r={R}
          style={{ strokeDasharray: C, strokeDashoffset: C * (1 - fill) }}
        />
      </svg>
      <img src={mark} class="rm-logo" alt="" />
      {state === "ok" && (
        <>
          <span class="rm-burst">
            {[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ "--a": `${i * 72 - 90}deg` }} />)}
          </span>
          <span class="rm-ok-b">
            <Tick />
          </span>
        </>
      )}
    </div>
  );
}
