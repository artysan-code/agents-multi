// output.ts — Terminal output: colours, status icons and the doctor's report.

export type Status = "ok" | "warn" | "fail";
/** One step of a guided repair: a console action (named in the allowlist, params checked by the
 *  server), something the person does, or a re-run of the check that asked for the repair. */
export type RepairStep =
  | { kind: "action"; action: string; args?: Record<string, string>; cmd: string }
  | { kind: "user"; text: string }
  | { kind: "verify" };
export interface Check {
  id: string;
  status: Status;
  msg: string;
  /** What to do, as text or a command to copy. */
  fix?: string;
  /** The same fix as steps the console can walk through (`cmd` of an action: to run it by hand). */
  repair?: RepairStep[];
}

export const ANSI = {
  g: "\x1b[32m",
  y: "\x1b[33m",
  r: "\x1b[31m",
  d: "\x1b[2m",
  b: "\x1b[1m",
  c: "\x1b[36m",
  x: "\x1b[0m",
};
export const icon: Record<Status, string> = {
  ok: `${ANSI.g}✓${ANSI.x}`,
  warn: `${ANSI.y}!${ANSI.x}`,
  fail: `${ANSI.r}✗${ANSI.x}`,
};

export function printDoctor(checks: Check[]) {
  const order: Status[] = ["fail", "warn", "ok"];
  const sorted = [...checks].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  console.log(`${ANSI.b}agents-multi doctor${ANSI.x}`);
  for (const c of sorted) {
    console.log(
      `  ${icon[c.status]} ${c.msg}${c.fix && c.status !== "ok" ? `\n      ${ANSI.d}fix:${ANSI.x} ${c.fix}` : ""}`,
    );
  }
  const n = (s: Status) => checks.filter((c) => c.status === s).length;
  console.log(`\n  ${n("ok")} pass · ${ANSI.y}${n("warn")} warn${ANSI.x} · ${ANSI.r}${n("fail")} fail${ANSI.x}`);
  return n("fail") ? 1 : 0;
}
