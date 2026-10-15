// pair-lib.ts — what `agents node pair --plain` prints (the console runs it as a job), read by the page: the code to
// show, the address where it is typed, and how it ended. Pure, so the output format has a test.

export interface PairView {
  code: string | null;
  url: string | null;
  /** the node's name once the pairing is through */
  paired: string | null;
}

/** Pure: the lines `CODE …`, `OPEN …` and `PAIRED …` in the job's output so far. */
export function pairView(output: string): PairView {
  const line = (k: string) => output.match(new RegExp(`^${k} (\\S+)\\s*$`, "m"))?.[1] ?? null;
  const code = line("CODE");
  return { code: code && /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code) ? code : null, url: line("OPEN"), paired: line("PAIRED") };
}

/** Pure: why a job that did not pair ended, from its output: the last line that says something. */
export function pairFailure(output: string): string {
  const lines = output.split("\n").map((l) => l.trim()).filter((l) => l && !/^(CODE|OPEN|EXPIRES) /.test(l));
  return lines.at(-1) ?? "";
}
