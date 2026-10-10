// steps.tsx — a run's steps, one row each with its mark, and the bar of the one running (styles in
// screen.css): the update screen (pages/system/wizard.tsx) and the first-run wizard (pages/setup/) draw
// their progress with it. And `RunMark`, the update screen's head: a ring of one arc per step that
// fills as they go, the share in the middle; at the end the arcs close into one ring and a tick draws.

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

const R = 30, C = 2 * Math.PI * R;
/** The gap between two steps' arcs, in degrees. */
const GAP = 14;

/** Pure: each step's arc as a dash on the ring — where it starts (degrees from the top) and how long it
 *  is (in the circle's length units). One step, or none, is the whole ring. */
export function arcs(n: number): { from: number; len: number }[] {
  if (n <= 1) return [{ from: 0, len: C }];
  const each = 360 / n;
  return Array.from({ length: n }, (_, i) => ({ from: i * each + GAP / 2, len: ((each - GAP) / 360) * C }));
}

export function RunMark(
  { states, state }: { states: StepState[]; state: "idle" | "on" | "ok" | "bad" },
) {
  const pct = Math.round((state === "ok" ? 1 : runShare(states)) * 100);
  const segs = arcs(states.length);
  return (
    <div class={`rm rm-${state}`} aria-hidden="true">
      <svg viewBox="0 0 72 72" class="rm-ring">
        {segs.map((a, i) => {
          const st = states.length > 1 ? states[i] : state === "ok" ? "done" : states[0] ?? "todo";
          return (
            <circle
              key={i}
              class={`rm-seg rm-${st}`}
              cx="36"
              cy="36"
              r={R}
              style={{
                "--i": i,
                strokeDasharray: `${a.len} ${C}`,
                transform: `rotate(${a.from - 90}deg)`,
              }}
            />
          );
        })}
        <circle class="rm-whole" cx="36" cy="36" r={R} />
      </svg>
      <span class="rm-c">
        {state === "ok" ? <Tick /> : state === "bad" ? <b>!</b> : (
          <span class="rm-pct">
            {pct}
            <small>%</small>
          </span>
        )}
      </span>
      {state === "ok" && <span class="rm-ripple" />}
    </div>
  );
}
