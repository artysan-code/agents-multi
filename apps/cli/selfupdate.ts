// selfupdate.ts — claude-multi updating itself: `claude-multi self-update`, the third part of
// `claude-multi update` (and of its timer, `--auto`) next to Claude Code and Claude Desktop.
//
// The repository is the program, so updating it is a pull, with the same care as the one before a
// launch (bin/lib/prelaunch.sh): only fast-forward, only on a clean tree, never a push. Then what
// runs the old code catches up: the console and the tray app restart when their code changed, the
// generated settings are rebuilt, and `install` runs when it has something to do — but only with
// every Claude closed, since it rewrites files they hold; otherwise it waits for a later round (the
// timer comes back every four hours) and the console says so. Every result lands in the update log.

import { uiLanguage } from "./lib/locale.ts";
import { CACHE, REPO, STATE } from "./lib/paths.ts";
import { run } from "./lib/proc.ts";
import { blockers } from "./mcp/apply.ts";
import { syncAllSettings } from "./settings.ts";

export interface RepoView {
  upstream: string | null;
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
}
export type SelfPlan = { do: "pull" } | { do: "nothing"; why: string } | { do: "skip"; why: string };

/** Pure: what to do with the repository as it stands after a fetch. */
export function selfPlan(r: RepoView): SelfPlan {
  if (!r.upstream) return { do: "skip", why: `branch ${r.branch} follows no remote branch` };
  if (!r.behind) {
    return { do: "nothing", why: r.ahead ? `up to date (${r.ahead} commits of yours not pushed)` : "up to date" };
  }
  if (r.ahead) return { do: "skip", why: `diverged from ${r.upstream} (↓${r.behind} ↑${r.ahead}): a rebase by hand` };
  if (r.dirty) {
    return { do: "skip", why: `${r.dirty} files changed and not committed: commit or put them aside, then update` };
  }
  return { do: "pull" };
}

/** Pure: which running parts a set of changed files makes stale. */
export function staleParts(changed: string[]): { console: boolean; app: boolean } {
  return {
    console: changed.some((f) =>
      f.startsWith("apps/cli/") && !f.startsWith("apps/cli/tests/") || f.startsWith("shared/mcp/lib/")
    ),
    app: changed.some((f) => f.startsWith("apps/tray/")),
  };
}

// ---------------------------------------------------------------- how it speaks
// The row of bin/lib/ui.sh, so that `claude-multi update` lines up: an icon, the name, the version,
// what happened, and dimmed details under it. claude-update passes its language and whether to colour
// (CM_LANG, CM_COLOR); alone, the machine's language and whether this is a terminal.
const lang = (Deno.env.get("CM_LANG") || uiLanguage(Deno.env.toObject())) === "it" ? "it" : "en";
const colour = Deno.env.has("CM_COLOR")
  ? !!Deno.env.get("CM_COLOR")
  : Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR");
const C = colour
  ? { ok: "\x1b[32m", warn: "\x1b[33m", bad: "\x1b[31m", dim: "\x1b[2m", b: "\x1b[1m", x: "\x1b[0m" }
  : { ok: "", warn: "", bad: "", dim: "", b: "", x: "" };
const commits = (n: number) => lang === "it" ? `${n} commit` : `${n} commit${n === 1 ? "" : "s"}`;
const T = {
  it: {
    latest: "già all'ultima versione",
    unpushed: (n: number) => `${commits(n)} ${n === 1 ? "tuo" : "tuoi"} ancora da pushare`,
    offline: "senza rete: è lo stato dell'ultimo controllo",
    updated: (from: string, n: number) => `aggiornato da ${from} (${commits(n)})`,
    available: (n: number) => `${commits(n)} ${n === 1 ? "nuovo" : "nuovi"} da prendere`,
    notUpdated: "non aggiornato",
    dirty: (n: number) =>
      `${
        n === 1
          ? "1 file modificato e non committato: committalo o mettilo"
          : `${n} file modificati e non committati: committali o mettili`
      } da parte, poi rilancia`,
    diverged: (b: number, a: number) => `la storia è divergente (↓${b} ↑${a}): serve un rebase a mano`,
    noUpstream: (b: string) => `il branch ${b} non segue un branch remoto`,
    installWait:
      "install ha del lavoro e aspetta che chiudi ogni Claude: lo fa il prossimo giro, o lancia claude-multi install",
    installDone: "install eseguito",
    installFail: "install non riuscito: lancia claude-multi install per vedere perché",
    restarted: (console: boolean, app: boolean) =>
      console && app
        ? "riavviate la console e l'app: giravano col codice vecchio"
        : `riavviata ${console ? "la console" : "l'app"}: girava col codice vecchio`,
    pullFail: "pull non riuscito: git pull --ff-only nel repo per vedere perché",
    notRepo: "non è un repository git: niente da aggiornare",
  },
  en: {
    latest: "already the latest",
    unpushed: (n: number) => `${commits(n)} of yours not pushed yet`,
    offline: "offline: as of the last check",
    updated: (from: string, n: number) => `updated from ${from} (${commits(n)})`,
    available: (n: number) => `${commits(n)} to take`,
    notUpdated: "not updated",
    dirty: (n: number) =>
      `${n === 1 ? "1 file" : `${n} files`} changed and not committed: commit or put ${
        n === 1 ? "it" : "them"
      } aside, then run it again`,
    diverged: (b: number, a: number) => `diverged history (↓${b} ↑${a}): a rebase by hand`,
    noUpstream: (b: string) => `branch ${b} follows no remote branch`,
    installWait:
      "install has work to do and waits for every Claude to be closed: the next round does it, or run claude-multi install",
    installDone: "install done",
    installFail: "install failed: run claude-multi install to see why",
    restarted: (console: boolean, app: boolean) =>
      `restarted ${
        [console && "the console", app && "the app"].filter(Boolean).join(" and ")
      }: it was running the old code`,
    pullFail: "pull failed: git pull --ff-only in the repository to see why",
    notRepo: "not a git repository: nothing to update",
  },
}[lang];

const ICON = { ok: ["✓", C.ok], new: ["↑", C.ok], wait: ["!", C.warn], fail: ["✗", C.bad] } as const;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].length));
/** Pure-ish: the row, as bin/lib/ui.sh prints it. */
function row(kind: keyof typeof ICON, version: string, text: string): string {
  const [icon, col] = ICON[kind];
  return `  ${col}${icon}${C.x} ${C.b}${pad("claude-multi", 15)}${C.x} ${pad(version, 10)} ${text}`;
}
const note = (text: string) => `${" ".repeat(31)}${C.dim}${text}${C.x}`;
/** Why a repository is not updated, in words. */
const skipWhy = (r: RepoView) =>
  !r.upstream ? T.noUpstream(r.branch) : r.ahead ? T.diverged(r.behind, r.ahead) : T.dirty(r.dirty);

const PENDING = `${STATE}/install-pending`;
const SKIPPED = `${CACHE}/self-update-skipped`;

async function log(event: string, from: string, to: string, detail = "") {
  await Deno.mkdir(STATE, { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    component: "claude-multi",
    event,
    from,
    to,
    detail,
  });
  await Deno.writeTextFile(`${STATE}/updates.jsonl`, line + "\n", { append: true });
}

const g = (...a: string[]) => run("git", ["-C", REPO, ...a]);

async function view(): Promise<RepoView> {
  const upstream = (await g("rev-parse", "--abbrev-ref", "@{u}")).out || null;
  const [behind, ahead] = upstream
    ? (await g("rev-list", "--left-right", "--count", "@{u}...HEAD")).out.split(/\s+/).map(Number)
    : [0, 0];
  return {
    upstream,
    branch: (await g("rev-parse", "--abbrev-ref", "HEAD")).out,
    ahead: ahead || 0,
    behind: behind || 0,
    dirty: (await g("status", "--porcelain")).out.split("\n").filter(Boolean).length,
  };
}

/** `install --dry-run` and whether it found anything to do. */
async function installPending(): Promise<boolean> {
  const r = await run(`${REPO}/bin/claude-multi`, ["install", "--dry-run"]);
  return r.code === 0 && !/nothing to do/.test(r.out);
}

/** Install now if nothing holds the files it rewrites, or leave it for a later round. */
async function settleInstall(head: string, say: (s: string) => void): Promise<boolean> {
  if (!(await installPending())) {
    await Deno.remove(PENDING).catch(() => {});
    return true;
  }
  const block = Object.keys(await blockers());
  if (block.length) {
    const first = !(await Deno.stat(PENDING).catch(() => null));
    await Deno.writeTextFile(PENDING, head);
    if (first) await log("waiting", "", head, `install waits for Claude to be closed (${block.join(", ")})`);
    say(note(T.installWait));
    return true;
  }
  const r = await run(`${REPO}/bin/claude-multi`, ["install"]);
  if (r.code === 0) {
    await Deno.remove(PENDING).catch(() => {});
    await log("applied", "", head, "install");
    say(note(T.installDone));
    return true;
  } else {
    await log("failed", "", head, `install: ${(r.err || r.out).split("\n").slice(-2).join(" ")}`);
    say(note(T.installFail));
    return false;
  }
}

/**
 * One round. `quiet` (the timer) prints nothing; a skip is logged once per upstream commit, so a
 * tree left dirty for days does not fill the log. Returns 0, or 1 when something failed.
 */
export async function selfUpdate({ quiet = false } = {}): Promise<number> {
  const say = (s: string) => {
    if (!quiet) console.log(s);
  };
  if ((await g("rev-parse", "--git-dir")).code !== 0) {
    say(row("ok", "", T.notRepo));
    return 0;
  }
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
    say(row("wait", from, T.notUpdated));
    say(note(skipWhy(r)));
    return 0;
  }
  if (plan.do === "nothing") {
    say(row("ok", from, T.latest));
    if (r.ahead) say(note(T.unpushed(r.ahead)));
    if (fetched.code) say(note(T.offline));
    if (await Deno.stat(PENDING).catch(() => null)) return await settleInstall(from, say) ? 0 : 1;
    return 0;
  }
  const pull = await g("pull", "-q", "--ff-only");
  const to = (await g("rev-parse", "--short", "HEAD")).out;
  if (pull.code !== 0 || to === from) {
    await log("failed", from, "", pull.err.split("\n").slice(-2).join(" ") || "pull failed");
    say(row("fail", from, T.notUpdated));
    say(note(T.pullFail));
    return 1;
  }
  await Deno.remove(SKIPPED).catch(() => {});
  const changed = (await g("diff", "--name-only", from, to)).out.split("\n").filter(Boolean);
  await log("installed", from, to, `${r.behind} commit${r.behind === 1 ? "" : "s"}`);
  say(row("new", to, T.updated(from, r.behind)));
  await syncAllSettings().catch(() => {});
  const installed = await settleInstall(to, say);
  // last, and without waiting: the console may be the one running this round (its Update button),
  // and restarting it ends whatever runs inside it
  const stale = staleParts(changed);
  const units = [stale.app && "claude-multi-app.service", stale.console && "claude-multi-console.service"].filter((
    u,
  ): u is string => !!u);
  if (units.length) {
    say(note(T.restarted(stale.console, stale.app)));
    await run("systemctl", ["--user", "--no-block", "try-restart", ...units]);
  }
  return installed ? 0 : 1;
}

/** `self-update --check` as a row: what a round would do, without doing it. 10 when there is
 *  something to take, as `update --check` counts it. */
export async function selfCheckRow(): Promise<number> {
  const c = await selfCheck();
  const r = await view(); // after the fetch selfCheck made
  if (c.plan.do === "pull") {
    console.log(row("wait", c.current, T.available(c.behind)));
    return 10;
  }
  if (c.plan.do === "skip") {
    console.log(row("wait", c.current, T.notUpdated));
    console.log(note(skipWhy(r)));
    return 0;
  }
  console.log(row("ok", c.current, T.latest));
  if (r.ahead) console.log(note(T.unpushed(r.ahead)));
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
