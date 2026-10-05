// selfupdate.ts — claude-multi updating itself: `claude-multi self-update`, the third part of
// `claude-multi update` (and of its timer, `--auto`) next to Claude Code and Claude Desktop.
//
// The repository is the program, so updating it is a pull, with the same care as the one before a
// launch (bin/lib/prelaunch.sh): only fast-forward, only on a clean tree, never a push. Then what
// runs the old code catches up: the console and the tray app restart when their code changed, the
// generated settings are rebuilt, and `install` runs when it has something to do — but only with
// every Claude closed, since it rewrites files they hold; otherwise it waits for a later round (the
// timer comes back every four hours) and the console says so. Every result lands in the update log.

import { ANSI, CACHE, REPO, run, STATE } from "./lib.ts";
import { blockers } from "./mcp.ts";
import { syncAllSettings } from "./settings.ts";

export interface RepoView { upstream: string | null; branch: string; ahead: number; behind: number; dirty: number }
export type SelfPlan = { do: "pull" } | { do: "nothing"; why: string } | { do: "skip"; why: string };

/** Pure: what to do with the repository as it stands after a fetch. */
export function selfPlan(r: RepoView): SelfPlan {
  if (!r.upstream) return { do: "skip", why: `branch ${r.branch} follows no remote branch` };
  if (!r.behind) return { do: "nothing", why: r.ahead ? `up to date (${r.ahead} commits of yours not pushed)` : "up to date" };
  if (r.ahead) return { do: "skip", why: `diverged from ${r.upstream} (↓${r.behind} ↑${r.ahead}): a rebase by hand` };
  if (r.dirty) return { do: "skip", why: `${r.dirty} files changed and not committed: commit or put them aside, then update` };
  return { do: "pull" };
}

/** Pure: which running parts a set of changed files makes stale. */
export function staleParts(changed: string[]): { console: boolean; app: boolean } {
  return {
    console: changed.some((f) => f.startsWith("cli/") && !f.startsWith("cli/tests/") || f.startsWith("shared/mcp/lib/")),
    app: changed.some((f) => f.startsWith("lib/claude-multi-app/")),
  };
}

const PENDING = `${STATE}/install-pending`;
const SKIPPED = `${CACHE}/self-update-skipped`;

async function log(event: string, from: string, to: string, detail = "") {
  await Deno.mkdir(STATE, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), component: "claude-multi", event, from, to, detail });
  await Deno.writeTextFile(`${STATE}/updates.jsonl`, line + "\n", { append: true });
}

const g = (...a: string[]) => run("git", ["-C", REPO, ...a]);

async function view(): Promise<RepoView> {
  const upstream = (await g("rev-parse", "--abbrev-ref", "@{u}")).out || null;
  const [behind, ahead] = upstream ? (await g("rev-list", "--left-right", "--count", "@{u}...HEAD")).out.split(/\s+/).map(Number) : [0, 0];
  return {
    upstream, branch: (await g("rev-parse", "--abbrev-ref", "HEAD")).out,
    ahead: ahead || 0, behind: behind || 0, dirty: (await g("status", "--porcelain")).out.split("\n").filter(Boolean).length,
  };
}

/** `install --dry-run` and whether it found anything to do. */
async function installPending(): Promise<boolean> {
  const r = await run(`${REPO}/bin/claude-multi`, ["install", "--dry-run"]);
  return r.code === 0 && !/nothing to do/.test(r.out);
}

/** Install now if nothing holds the files it rewrites, or leave it for a later round. */
async function settleInstall(head: string, say: (s: string) => void) {
  if (!(await installPending())) { await Deno.remove(PENDING).catch(() => {}); return; }
  const block = Object.keys(await blockers());
  if (block.length) {
    const first = !(await Deno.stat(PENDING).catch(() => null));
    await Deno.writeTextFile(PENDING, head);
    if (first) await log("waiting", "", head, `install waits for Claude to be closed (${block.join(", ")})`);
    say(`${ANSI.y}install${ANSI.x} has work to do and waits for every Claude to be closed (${block.join(", ")}): the next round does it, or run claude-multi install then`);
    return;
  }
  const r = await run(`${REPO}/bin/claude-multi`, ["install"]);
  if (r.code === 0) {
    await Deno.remove(PENDING).catch(() => {});
    await log("applied", "", head, "install");
    say(`${ANSI.g}install${ANSI.x} done`);
  } else {
    await log("failed", "", head, `install: ${(r.err || r.out).split("\n").slice(-2).join(" ")}`);
    say(`${ANSI.r}install failed${ANSI.x}: claude-multi install, to see why`);
  }
}

/**
 * One round. `quiet` (the timer) prints nothing; a skip is logged once per upstream commit, so a
 * tree left dirty for days does not fill the log. Returns 0, or 1 when something failed.
 */
export async function selfUpdate({ quiet = false } = {}): Promise<number> {
  const say = (s: string) => { if (!quiet) console.log(`  ${s}`); };
  if ((await g("rev-parse", "--git-dir")).code !== 0) { say("not a git repository: nothing to update"); return 0; }
  const fetched = await run("timeout", ["30", "git", "-C", REPO, "fetch", "-q", "origin"]);
  if (fetched.code === 0) await Deno.writeTextFile(`${CACHE}/fetch.stamp`, "").catch(() => {});
  const r = await view();
  const plan = selfPlan(r);
  const from = (await g("rev-parse", "--short", "HEAD")).out;
  if (plan.do === "skip") {
    const upstreamHead = r.upstream ? (await g("rev-parse", "--short", "@{u}")).out : "";
    if (r.behind && (await Deno.readTextFile(SKIPPED).catch(() => "")) !== upstreamHead) {
      await Deno.writeTextFile(SKIPPED, upstreamHead).catch(() => {});
      await log("skipped", from, upstreamHead, plan.why);
    }
    say(`${ANSI.y}not updated${ANSI.x}: ${plan.why}`);
    return 0;
  }
  if (plan.do === "nothing") {
    say(`${ANSI.g}ok${ANSI.x} ${from} — ${plan.why}${fetched.code ? " (no network: as of the last fetch)" : ""}`);
    if (await Deno.stat(PENDING).catch(() => null)) await settleInstall(from, say);
    return 0;
  }
  const pull = await g("pull", "-q", "--ff-only");
  const to = (await g("rev-parse", "--short", "HEAD")).out;
  if (pull.code !== 0 || to === from) {
    await log("failed", from, "", pull.err.split("\n").slice(-2).join(" ") || "pull failed");
    say(`${ANSI.r}pull failed${ANSI.x}: git -C ${REPO} pull --ff-only, to see why`);
    return 1;
  }
  await Deno.remove(SKIPPED).catch(() => {});
  const changed = (await g("diff", "--name-only", from, to)).out.split("\n").filter(Boolean);
  await log("installed", from, to, `${r.behind} commit${r.behind === 1 ? "" : "s"}`);
  say(`${ANSI.g}updated${ANSI.x} ${from} → ${to} (${r.behind} commit${r.behind === 1 ? "" : "s"})`);
  await syncAllSettings().catch(() => {});
  await settleInstall(to, say);
  // last, and without waiting: the console may be the one running this round (its Update button),
  // and restarting it ends whatever runs inside it
  const stale = staleParts(changed);
  const units = [stale.app && "claude-multi-app.service", stale.console && "claude-multi-console.service"].filter((u): u is string => !!u);
  if (units.length) {
    say(`restarting ${units.join(" and ")} (old code)`);
    await run("systemctl", ["--user", "--no-block", "try-restart", ...units]);
  }
  return 0;
}

/** For `update --check`: how far behind the repository is after a fetch, without changing it. */
export async function selfCheck(): Promise<{ current: string; behind: number; plan: SelfPlan }> {
  await run("timeout", ["15", "git", "-C", REPO, "fetch", "-q", "origin"]);
  const r = await view();
  return { current: (await g("rev-parse", "--short", "HEAD")).out, behind: r.behind, plan: selfPlan(r) };
}

/** Whether an install is waiting for Claude to be closed, and since which commit. */
export async function installWaiting(): Promise<string | null> {
  return (await Deno.readTextFile(PENDING).catch(() => "")).trim() || null;
}
