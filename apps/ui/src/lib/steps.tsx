// steps.tsx — a run's steps, one row each with its mark and its bar (styles in screen.css): the update
// screen (pages/system/wizard.tsx) and the first-run wizard (pages/setup/) draw their progress with it.

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

export function StepRows({ rows }: { rows: StepRow[] }) {
  return (
    <ol class="uw-steps">
      {rows.map(({ key, label, state: st, detail, pct }) => (
        <li key={key} class={`uw-${st}`}>
          <span class="uw-ic">
            {st === "running"
              ? <span class="spin2" />
              : st === "done"
              ? "✓"
              : st === "failed"
              ? "!"
              : st === "skipped"
              ? "–"
              : ""}
          </span>
          <span class="uw-n">{label}</span>
          <span class="uw-d">{detail ?? ""}</span>
          <span class="uw-bar">
            <i
              class={st === "running" && pct == null ? "ind" : ""}
              style={{
                width: st === "done" || st === "skipped"
                  ? "100%"
                  : pct != null
                  ? `${pct}%`
                  : st === "running"
                  ? "40%"
                  : "0",
              }}
            />
          </span>
        </li>
      ))}
    </ol>
  );
}
