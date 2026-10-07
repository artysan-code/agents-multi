// ui.ts — the console's interface (apps/ui): built with pnpm into apps/ui/dist, which the console
// serves at its root. The build carries the git tree it was made from, so a pull that changed apps/ui
// is seen as a stale build. A failed build leaves the previous one in place.

import { REPO } from "./lib/paths.ts";
import { has, run } from "./lib/proc.ts";

export const UI = `${REPO}/apps/ui`;
export const UI_DIST = `${UI}/dist`;
const STAMP = ".source";

export type UiState = "built" | "stale" | "missing";

/** Pure: a build against the tree of apps/ui it should match. */
export function uiState(stamp: string | null, tree: string): UiState {
  if (stamp === null) return "missing";
  return stamp.trim() === tree ? "built" : "stale";
}

/** The committed tree of apps/ui (empty outside a git checkout). */
async function uiTree(): Promise<string> {
  return (await run("git", ["-C", REPO, "rev-parse", "HEAD:apps/ui"])).out;
}

export async function uiStatus(): Promise<UiState> {
  const stamp = await Deno.readTextFile(`${UI_DIST}/${STAMP}`).catch(() => null);
  return uiState(stamp, await uiTree());
}

/** Builds the interface into dist.next, then swaps it in. `say` gets one line per step. */
export async function uiBuild(say: (s: string) => void = () => {}): Promise<{ ok: boolean; error?: string }> {
  if (!(await has("pnpm"))) return { ok: false, error: "pnpm is not installed" };
  const next = `${UI}/dist.next`;
  const steps: [string, string[]][] = [
    ["install", ["install", "--frozen-lockfile", "--silent"]],
    ["typecheck", ["exec", "tsc", "--noEmit"]],
    ["build", ["exec", "vite", "build", "--logLevel", "warn", "--outDir", "dist.next", "--emptyOutDir"]],
  ];
  for (const [name, args] of steps) {
    say(`ui: ${name}`);
    const r = await run("pnpm", args, { cwd: UI });
    if (r.code !== 0) {
      await Deno.remove(next, { recursive: true }).catch(() => {});
      return { ok: false, error: `${name}: ${(r.err || r.out).split("\n").slice(-3).join(" ")}` };
    }
  }
  await Deno.writeTextFile(`${next}/${STAMP}`, `${await uiTree()}\n`);
  const old = `${UI}/dist.old`;
  await Deno.remove(old, { recursive: true }).catch(() => {});
  await Deno.rename(UI_DIST, old).catch(() => {});
  await Deno.rename(next, UI_DIST);
  await Deno.remove(old, { recursive: true }).catch(() => {});
  return { ok: true };
}

/** `agents ui build`: builds, and says why when it cannot. */
export async function uiCommand(args: string[]): Promise<number> {
  if (args[0] !== "build") {
    console.error("usage: agents ui build");
    return 2;
  }
  const r = await uiBuild((s) => console.log(s));
  if (!r.ok) {
    console.error(`ui build failed: ${r.error}`);
    return 1;
  }
  console.log(`ui: built into ${UI_DIST}`);
  return 0;
}
