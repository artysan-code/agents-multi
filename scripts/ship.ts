#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * ship.ts — the one way a version leaves `dev` (docs/adr/0002): brings `dev` in step with what CI and
 * the other branches added, runs the gate, moves the branch by fast-forward, cuts the version with
 * release.ts, pushes the branch and its tag, and merges the result back down to `dev`.
 *
 *   deno task ship beta [major|minor|patch]   the next beta, cut on `beta` from `dev`
 *   deno task ship rc                         the release candidate, cut on `beta` from `dev`
 *   deno task ship stable --yes               the stable version, cut on `release` from `beta`
 *   deno task ship <kind> --dry-run           print the steps, change nothing
 *
 * Betas and release candidates are shipped whenever they are needed; a stable version only with the
 * owner's go-ahead (AGENTS.md), which is why it needs `--yes`. Run it from `dev`, with a clean tree.
 */

import { git, gitIn } from "./lib/git.ts";

export type Kind = "beta" | "rc" | "stable";

/** One git (or release.ts) invocation of the plan, and what it is for. */
export interface Step {
  run: string[];
  why: string;
}

/** Pure: the steps that ship `kind` (after `dev` is up to date and merged, which `main` does first). */
export function shipSteps(kind: Kind, aim?: string): Step[] {
  const cut = kind === "stable" ? [] : [kind, ...(aim ? [aim] : [])];
  if (kind !== "stable") {
    return [
      { run: ["git", "checkout", "-q", "-B", "beta", "origin/beta"], why: "beta as the remote has it" },
      { run: ["git", "merge", "--ff-only", "dev"], why: "beta moves to dev by fast-forward" },
      { run: ["release", ...cut], why: "the version: manifests, CHANGELOG, commit, tag" },
      { run: ["git", "push", "origin", "beta", "{tag}"], why: "the tag builds the bundles (CI)" },
      { run: ["git", "checkout", "-q", "dev"], why: "" },
      { run: ["git", "merge", "--ff-only", "beta"], why: "the release commit back on dev" },
      { run: ["git", "push", "origin", "dev"], why: "" },
    ];
  }
  return [
    // CI commits each rc's update manifest on release; dev has merged it, beta has not: without this,
    // release could never fast-forward to beta
    { run: ["git", "checkout", "-q", "-B", "beta", "origin/beta"], why: "beta as the remote has it" },
    {
      run: ["git", "merge", "--ff-only", "dev"],
      why: "beta takes what CI left on release (merges and manifests only)",
    },
    { run: ["git", "push", "origin", "beta"], why: "" },
    { run: ["git", "checkout", "-q", "-B", "release", "origin/release"], why: "release as the remote has it" },
    { run: ["git", "merge", "--ff-only", "origin/beta"], why: "release moves to beta by fast-forward" },
    { run: ["release"], why: "the version: manifests, CHANGELOG, commit, tag" },
    { run: ["git", "push", "origin", "release", "{tag}"], why: "the tag builds the bundles (CI)" },
    { run: ["git", "checkout", "-q", "-B", "beta", "origin/beta"], why: "" },
    { run: ["git", "merge", "--ff-only", "release"], why: "beta carries the stable version" },
    { run: ["git", "push", "origin", "beta"], why: "" },
    { run: ["git", "checkout", "-q", "dev"], why: "" },
    { run: ["git", "merge", "--no-edit", "release"], why: "the release commit back on dev" },
    { run: ["git", "push", "origin", "dev"], why: "" },
  ];
}

/** Pure: the arguments, or why they are wrong. */
export function parseArgs(args: string[]): { kind: Kind; aim?: string; dry: boolean; yes: boolean } | string {
  const [kind, aim, ...rest] = args.filter((a) => !a.startsWith("--"));
  if (kind !== "beta" && kind !== "rc" && kind !== "stable") return "usage: deno task ship beta|rc|stable";
  if (rest.length) return `unexpected: ${rest.join(" ")}`;
  if (aim && (kind !== "beta" || !["major", "minor", "patch"].includes(aim))) {
    return `only a beta takes a target (beta major | minor | patch), not ${kind} ${aim}`;
  }
  return { kind, aim, dry: args.includes("--dry-run"), yes: args.includes("--yes") };
}

/** Pure: the subjects (merges excluded) that `beta` would take from `dev` which are not update manifests. */
export function untried(subjects: string[]): string[] {
  return subjects.filter((s) => s && !s.startsWith("chore(updates):"));
}

const show = (s: Step) => `  ${s.run.join(" ")}${s.why ? `   # ${s.why}` : ""}`;

/** Whether `ref` is already in HEAD's history. */
async function contains(ref: string): Promise<boolean> {
  const out = await new Deno.Command("git", { args: ["merge-base", "--is-ancestor", ref, "HEAD"] }).output();
  return out.success;
}

async function run(step: string[]): Promise<void> {
  if (step[0] === "release") {
    const out = await new Deno.Command("deno", {
      args: ["run", "--allow-read", "--allow-write", "--allow-run=git", "scripts/release.ts", ...step.slice(1)],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!out.success) throw new Error("release.ts failed");
    return;
  }
  await gitIn(".", ...step.slice(1));
}

async function main(args: string[]) {
  const a = parseArgs(args);
  if (typeof a === "string") throw new Error(a);
  Deno.chdir(await git("rev-parse", "--show-toplevel"));
  const steps = shipSteps(a.kind, a.aim);

  if (a.dry) {
    console.log(
      `ship ${a.kind}${
        a.aim ? ` ${a.aim}` : ""
      }: from dev, after merging origin/dev, origin/release and origin/beta into it and the gate\n`,
    );
    console.log(steps.map(show).join("\n"));
    return;
  }
  if (a.kind === "stable" && !a.yes) {
    throw new Error("a stable version ships only with the owner's go-ahead: deno task ship stable --yes");
  }
  if ((await git("rev-parse", "--abbrev-ref", "HEAD")) !== "dev") throw new Error("ship from dev");
  if (await git("status", "--porcelain")) throw new Error("the working tree is not clean");
  // the version first, before the gate and any branch moves: a kind that cannot follow the current
  // version (a beta after an rc) fails here, in a second, with nothing changed
  const cut = steps.find((s) => s.run[0] === "release")!.run.slice(1);
  const check = await new Deno.Command("deno", {
    args: ["run", "--quiet", "--allow-read", "--allow-run=git", "scripts/release.ts", ...cut, "--dry-run"],
    stdout: "null",
    stderr: "inherit",
  }).output();
  if (!check.success) throw new Error(`release.ts refuses ${a.kind}: nothing was shipped`);

  // dev in step: the remote's dev, then what CI committed on release (update manifests) and what
  // the last cut left on beta, so every branch below moves by fast-forward
  await gitIn(".", "fetch", "-q", "origin", "--tags");
  await gitIn(".", "merge", "-q", "--ff-only", "origin/dev");
  for (const b of ["origin/release", "origin/beta"]) {
    if (!(await contains(b))) await gitIn(".", "merge", "--no-edit", b);
  }
  if (a.kind === "stable") {
    // beta takes dev below: only if dev adds nothing an rc has not tried
    const rest = untried((await git("log", "--no-merges", "--format=%s", "origin/beta..dev")).split("\n"));
    if (rest.length) {
      throw new Error(
        `dev has commits no rc has tried (ship an rc first), nothing was shipped:\n  ${rest.join("\n  ")}`,
      );
    }
  }
  // the gate once here; the pushes below skip it (same commits, or only the release commit on top)
  const gate = await new Deno.Command("bash", { args: ["scripts/ci.sh"], stdout: "inherit", stderr: "inherit" })
    .output();
  if (!gate.success) throw new Error("scripts/ci.sh failed: nothing was shipped");
  await gitIn(".", "push", "-q", "--no-verify", "origin", "dev");

  let tag = "";
  for (const s of steps) {
    console.log(show(s));
    const step = s.run.map((x) => x === "{tag}" ? tag : x);
    if (step[0] === "git" && step[1] === "push") step.splice(2, 0, "--no-verify");
    await run(step);
    if (step[0] === "release") tag = `v${JSON.parse(await Deno.readTextFile("deno.json")).version}`;
  }
  console.log(`\nshipped ${tag}. CI builds it and commits its update manifest on release (merged by the next ship).`);
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (e) {
    console.error(`ship: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
