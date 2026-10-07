// claude.tsx — Claude's own look, from the Desktop bundle the server scans (/claude/assets.json): the
// spark, still or moving through one of its animations, and the Anthropicons glyphs. Without the
// bundle the spark is drawn from the path below and the glyphs are left to the caller's own icon.

import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { useEffect, useRef } from "preact/hooks";
import { get } from "../api.ts";

interface Strip {
  svg: string;
  frameCount: number;
  speed: number;
}
interface Assets {
  spark: string | null;
  strips: Record<string, Strip>;
  icons: Record<string, number>;
  iconFont: boolean;
}

const assets = signal<Assets>({ spark: null, strips: {}, icons: {}, iconFont: false });

export async function loadClaude(): Promise<void> {
  try {
    const a = await get<Assets & { found: boolean }>("/claude/assets.json");
    if (!a.found) return;
    assets.value = {
      spark: a.spark?.replace(/fill="#[0-9a-fA-F]{3,8}"/g, 'fill="currentColor"') ?? null,
      strips: a.strips,
      icons: a.icons,
      iconFont: a.iconFont,
    };
  } catch { /* the still spark below */ }
}

const STILL_PATH =
  "M12 2.5l1.6 6.2 5.6-3.2-3.2 5.6 6.2 1.6-6.2 1.6 3.2 5.6-5.6-3.2L12 22.9l-1.6-6.2-5.6 3.2 3.2-5.6L1.8 12.7 8 11.1 4.8 5.5l5.6 3.2z";

export type SparkMode = "" | "thinking" | "writing" | string;

/** A spark: still, or moving through one of Claude's animations ("thinking", "writing"…). The SVG
 *  markup is the bundle's own asset, set as is; nothing of a page's data goes into it. */
export function Spark({ mode = "", class: cls = "spark" }: { mode?: SparkMode; class?: string }) {
  const a = assets.value;
  const strip = mode ? a.strips[mode] : undefined;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ref = useRef<HTMLSpanElement>(null);
  const moving = strip && !reduced;
  useEffect(() => {
    if (!moving || !ref.current) return;
    // as Desktop does it: a strip of frames stacked top to bottom, stepped through by a transform
    const n = strip.frameCount;
    const anim = ref.current.animate(
      Array.from({ length: n }, (_, i) => ({ transform: `translateY(-${(100 / n) * i}%)` })),
      { duration: strip.speed * n, iterations: Infinity, easing: `steps(${n}, jump-none)` },
    );
    return () => anim.cancel();
  }, [strip, moving]);
  if (moving) {
    return (
      <span class={cls} data-spark={mode}>
        <span ref={ref} class="strip" style={{ height: `${strip.frameCount * 100}%` }} dangerouslySetInnerHTML={{ __html: strip.svg }} />
      </span>
    );
  }
  return a.spark
    ? <span class={cls} data-spark={mode} dangerouslySetInnerHTML={{ __html: a.spark }} />
    : (
      <span class={cls} data-spark={mode}>
        <svg viewBox="0 0 24 24"><path d={STILL_PATH} /></svg>
      </span>
    );
}

/** An Anthropicons glyph by name, or `fallback` when the font is not here. */
export function AIcon({ name, fallback = null }: { name: string; fallback?: ComponentChildren }) {
  const a = assets.value;
  const code = a.iconFont ? a.icons[name] : undefined;
  return code ? <i class="ai" aria-hidden="true">{String.fromCodePoint(code)}</i> : <>{fallback}</>;
}
