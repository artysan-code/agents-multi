// claude.tsx — the mark that stands for Claude at work in the console: Agents Multi's logo, still, or
// pulsing while Claude thinks or writes. Claude's own spark is Anthropic's mark, not ours to show.

import mark from "../assets/mark.svg";

export type SparkMode = "" | "thinking" | "writing" | string;

/** The mark: still, or moving while Claude is at work (any mode). */
export function Spark(
  { mode = "", class: cls = "spark" }: { mode?: SparkMode; class?: string },
) {
  return (
    <span class={cls} data-spark={mode || undefined}>
      <img src={mark} alt="" />
    </span>
  );
}
