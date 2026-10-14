// limitrules.ts — the limits manager (ADR 0010, part 2): rules over the accounts' usage windows
// (providers.ts reads them the passive way), the events they raise, and the proposals the owner accepts.
//
//   - at `stopAt` % of any window an account takes no new unattended work (`blocked`);
//   - a window about to reset with room left is a chance to use it (`expiring`): the owner is told, and a
//     coordinator can propose queued work or another account;
//   - a window that reset (`reset`) lets what waited for it go, and wakes the routines that named it.
//
// Nothing here switches an account on its own. A held routine raises a *proposal* (use account B instead);
// the owner accepts it through a coordinator, and only then does the console apply it. The pure part is
// `evaluate`; the rest keeps its files in the hub's state (`<runs>/limits/`), which the `agents` MCP server
// may write, and the owner's rules and project defaults in their configuration, which only the console and
// the CLI write.

import { runsDir } from "./agents.ts";
import type { Window } from "./limits.ts";
import { configDir } from "./owner.ts";
import type { ProviderName } from "./providers.ts";

// ---------------------------------------------------------------- rules

export interface Rules {
  /** an account at this % of any window takes no new unattended work */
  stopAt: number;
  /** a window resetting within this many minutes counts as expiring */
  expiringMin: number;
  /** ... when at least this % of it is still free */
  roomPercent: number;
  /** a firing held for a limit waits this long (minutes) before it counts as missed */
  holdMaxMin: number;
}

export const DEFAULT_RULES: Rules = { stopAt: 80, expiringMin: 60, roomPercent: 30, holdMaxMin: 720 };

const pct = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

/** Pure: the owner's rules file (`limits.json`) kept to what is valid, over the defaults. */
export function cleanRules(raw: unknown): Rules {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    stopAt: pct(r.stopAt, 1, 100) ?? DEFAULT_RULES.stopAt,
    expiringMin: pct(r.expiringMin, 1, 24 * 60) ?? DEFAULT_RULES.expiringMin,
    roomPercent: pct(r.roomPercent, 1, 99) ?? DEFAULT_RULES.roomPercent,
    holdMaxMin: pct(r.holdMaxMin, 1, 7 * 24 * 60) ?? DEFAULT_RULES.holdMaxMin,
  };
}

export const loadRules = async (config = configDir()): Promise<Rules> =>
  cleanRules(await Deno.readTextFile(`${config}/limits.json`).then(JSON.parse).catch(() => undefined));

// ---------------------------------------------------------------- accounts and project defaults

/** An account as a job names it: a profile and a provider. */
export interface AccountRef {
  profile: string;
  provider: ProviderName;
}
export const accountId = (a: AccountRef) => `${a.profile}/${a.provider}`;

/** Pure: `profile` or `profile/provider` (claude by default); null when it is neither. */
export function parseAccountId(text: string): AccountRef | null {
  const m = /^([a-z0-9][a-z0-9-]*)(?:\/(claude|codex))?$/.exec(text.trim());
  return m ? { profile: m[1], provider: (m[2] ?? "claude") as ProviderName } : null;
}

export type ProjectAccounts = Record<string, AccountRef>;

const relHome = (path: string, home: string) =>
  home && path.startsWith(`${home.replace(/\/$/, "")}/`) ? path.slice(home.replace(/\/$/, "").length + 1) : path;

/** Pure: a project's default account from the owner's table (`projects.json`: folder under home → account,
 *  e.g. `"work/otacon/smc": {"profile": "otacon"}`); the longest folder that contains the project wins, so a
 *  sub-project inherits its parent's. */
export function defaultAccount(table: unknown, project: string, home: string): AccountRef | null {
  if (!table || typeof table !== "object") return null;
  const here = relHome(project, home);
  let best: [string, AccountRef] | null = null;
  for (const [key, v] of Object.entries(table as Record<string, unknown>)) {
    const k = relHome(key.replace(/^~\//, ""), home).replace(/\/+$/, "");
    const a = v && typeof v === "object"
      ? parseAccountId(`${(v as AccountRef).profile}/${(v as AccountRef).provider ?? "claude"}`)
      : null;
    if (!a || !k) continue;
    if ((here === k || here.startsWith(`${k}/`)) && (!best || k.length > best[0].length)) best = [k, a];
  }
  return best ? best[1] : null;
}

export const readProjectAccounts = (config = configDir()) =>
  Deno.readTextFile(`${config}/projects.json`).then(JSON.parse).catch(() => ({}));

/** A project's default account, read from the owner's configuration. */
export async function projectAccount(
  project: string,
  config = configDir(),
  home = Deno.env.get("HOME") ?? "",
): Promise<AccountRef | null> {
  return defaultAccount(await readProjectAccounts(config), project, home);
}

/** Sets a project's default account in the owner's configuration (the console and the CLI only: the MCP
 *  server may not write there). The key is the folder under home. */
export async function setProjectAccount(
  project: string,
  account: AccountRef,
  config = configDir(),
  home = Deno.env.get("HOME") ?? "",
): Promise<void> {
  const table = await readProjectAccounts(config) as Record<string, unknown>;
  table[relHome(project, home)] = account.provider === "claude"
    ? { profile: account.profile }
    : { profile: account.profile, provider: account.provider };
  await Deno.mkdir(config, { recursive: true });
  const tmp = `${config}/projects.json.${crypto.randomUUID().slice(0, 6)}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(table, null, 2) + "\n");
  await Deno.rename(tmp, `${config}/projects.json`);
}

// ---------------------------------------------------------------- evaluate

export type LimitEventKind = "blocked" | "expiring" | "reset";

export interface LimitEvent {
  /** stable: the same thing is never announced twice */
  id: string;
  at: string;
  kind: LimitEventKind;
  account: string;
  window: string;
  used: number | null;
  resetsAt: number | null;
  detail: string;
}

/** What the manager remembers of an account between two scans. */
export interface AccountState {
  status: "ok" | "blocked";
  /** the window that blocks it, with its reset */
  by?: { window: string; used: number; resetsAt: number | null };
  /** window → its reset, as last read (a reset passing, or moving later, is a `reset`) */
  resets: Record<string, number | null>;
  /** window → the reset already announced as expiring */
  expiring: Record<string, number | null>;
  /** the highest use over its windows, null with none */
  used: number | null;
}

export const emptyState = (): AccountState => ({ status: "ok", resets: {}, expiring: {}, used: null });

const minutes = (secs: number) => Math.max(1, Math.round(secs / 60));

/** Pure: one account's state and the events a new reading raises. `windows` are the ones still running
 *  (the providers leave out a window whose reset has passed: unknown, never a guess). */
export function evaluate(
  account: string,
  prev: AccountState | undefined,
  windows: Window[],
  rules: Rules,
  now: number,
): { state: AccountState; events: LimitEvent[] } {
  const before = prev ?? emptyState();
  const events: LimitEvent[] = [];
  const at = new Date(now * 1000).toISOString();
  const ev = (kind: LimitEventKind, w: string, used: number | null, resetsAt: number | null, detail: string) =>
    events.push({
      id: `${account}:${w}:${kind}:${resetsAt ?? "x"}`,
      at,
      kind,
      account,
      window: w,
      used,
      resetsAt,
      detail,
    });

  // a reset: a window we knew whose time passed, or that came back with a later reset
  for (const [w, r] of Object.entries(before.resets)) {
    if (r === null) continue;
    const now_ = windows.find((x) => x.window === w);
    if (r <= now || (now_?.resetsAt != null && now_.resetsAt - r > 120)) {
      ev(
        "reset",
        w,
        null,
        r,
        `${account}: the ${w} window reset${before.status === "blocked" ? "; work held for it can go" : ""}`,
      );
    }
  }

  const worst = [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const blocking =
    windows.filter((w) => w.usedPercent >= rules.stopAt).sort((a, b) => b.usedPercent - a.usedPercent)[0];
  const state: AccountState = {
    status: blocking ? "blocked" : "ok",
    ...(blocking ? { by: { window: blocking.window, used: blocking.usedPercent, resetsAt: blocking.resetsAt } } : {}),
    resets: Object.fromEntries(windows.map((w) => [w.window, w.resetsAt])),
    expiring: {},
    used: worst ? Math.round(worst.usedPercent) : null,
  };
  if (blocking && before.status !== "blocked") {
    ev(
      "blocked",
      blocking.window,
      blocking.usedPercent,
      blocking.resetsAt,
      `${account} is at ${
        Math.round(blocking.usedPercent)
      }% of its ${blocking.window} window (stop at ${rules.stopAt}%): it takes no new unattended work` +
        (blocking.resetsAt ? ` until it resets in ${minutes(blocking.resetsAt - now)} min` : ""),
    );
  }
  // expiring with room left: only for an account still taking work
  for (const w of windows) {
    if (w.resetsAt === null) continue;
    const left = w.resetsAt - now;
    if (
      left <= 0 || left > rules.expiringMin * 60 || 100 - w.usedPercent < rules.roomPercent ||
      state.status === "blocked"
    ) continue;
    state.expiring[w.window] = w.resetsAt;
    if (before.expiring[w.window] !== w.resetsAt) {
      ev(
        "expiring",
        w.window,
        w.usedPercent,
        w.resetsAt,
        `${account}: the ${w.window} window resets in ${minutes(left)} min with ${
          Math.round(100 - w.usedPercent)
        }% free — queued work can use it`,
      );
    }
  }
  return { state, events };
}

// ---------------------------------------------------------------- the files

export const limitsDir = (runs = runsDir()) => `${runs}/limits`;

export interface Snapshot {
  /** epoch seconds of the last scan */
  at: number;
  accounts: Record<string, AccountState & { windows: Window[] }>;
}

export const readSnapshot = async (dir = limitsDir()): Promise<Snapshot | null> =>
  await Deno.readTextFile(`${dir}/state.json`).then(JSON.parse).catch(() => null);

/** Readings older than this say nothing: a console that stopped, or a status line nobody feeds. */
export const STALE_S = 30 * 60;

/** Pure: the accounts among `ids` that are blocked at `now` by the last scan; an old scan blocks nobody. */
export function blockedAmong(
  snap: Snapshot | null,
  ids: string[],
  now: number,
): { account: string; by: NonNullable<AccountState["by"]> }[] {
  if (!snap || now - snap.at > STALE_S) return [];
  return ids.flatMap((id) => {
    const a = snap.accounts[id];
    return a?.status === "blocked" && a.by ? [{ account: id, by: a.by }] : [];
  });
}

/** Pure: of the accounts, the ones that could take the work instead of `blocked`: not blocked, with a reading
 *  or none, lowest use first; the same provider ahead of another. */
export function alternatives(
  snap: Snapshot | null,
  all: { id: string; provider: ProviderName }[],
  blocked: string,
  now: number,
): string[] {
  const provider = all.find((a) => a.id === blocked)?.provider;
  const fresh = snap && now - snap.at <= STALE_S ? snap : null;
  return all
    .filter((a) => a.id !== blocked && fresh?.accounts[a.id]?.status !== "blocked")
    .sort((a, b) =>
      Number(b.provider === provider) - Number(a.provider === provider) ||
      (fresh?.accounts[a.id]?.used ?? 50) - (fresh?.accounts[b.id]?.used ?? 50) || a.id.localeCompare(b.id)
    )
    .map((a) => a.id);
}

export async function appendEvents(events: LimitEvent[], dir = limitsDir()): Promise<void> {
  if (!events.length) return;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/events.jsonl`, events.map((e) => JSON.stringify(e)).join("\n") + "\n", {
    append: true,
  });
}

export async function readEvents(dir = limitsDir(), last = 200): Promise<LimitEvent[]> {
  const text = await Deno.readTextFile(`${dir}/events.jsonl`).catch(() => "");
  return text.split("\n").filter(Boolean).slice(-last).flatMap((l) => {
    try {
      return [JSON.parse(l) as LimitEvent];
    } catch {
      return [];
    }
  });
}

export interface Reading {
  account: string;
  provider: ProviderName;
  windows: Window[];
}

export interface ScanDeps {
  now: () => number;
  /** every account with its running windows (providers.ts) */
  read: () => Promise<Reading[]>;
  rules: () => Promise<Rules>;
  notify: (title: string, body: string) => void | Promise<void>;
}

/** One scan: read every account's windows, run the rules, keep the snapshot and the events, tell the owner
 *  of each new event once. Returns the new events. */
export async function scan(deps: ScanDeps, dir = limitsDir()): Promise<LimitEvent[]> {
  const now = deps.now();
  const rules = await deps.rules();
  const prev = await readSnapshot(dir);
  const accounts: Snapshot["accounts"] = {};
  const events: LimitEvent[] = [];
  for (const r of await deps.read()) {
    const out = evaluate(r.account, prev?.accounts[r.account], r.windows, rules, now);
    accounts[r.account] = { ...out.state, windows: r.windows };
    events.push(...out.events);
  }
  const known = new Set((await readEvents(dir, 500)).map((e) => e.id));
  const fresh = events.filter((e) => !known.has(e.id));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(`${dir}/state.json`, JSON.stringify({ at: now, accounts }, null, 2) + "\n");
  await appendEvents(fresh, dir);
  for (const e of fresh) await deps.notify(`Limits: ${e.account} ${e.kind}`, e.detail);
  return fresh;
}

// ---------------------------------------------------------------- proposals

/** "Use account `to` instead of `from`": raised when work is held for a limit, or by a coordinator. Nothing
 *  changes until the owner accepts it; the console applies an accepted one. */
export interface Proposal {
  id: string;
  created: string;
  /** what it changes: this routine's account, or the project's default */
  scope: "routine" | "project";
  project: string;
  routine?: string;
  from: string;
  to: string;
  reason: string;
  status: "pending" | "accepted" | "declined" | "applied";
  /** who raised it: the console, or a coordinator */
  by: "console" | "coordinator";
  decided?: string;
}

const proposalsDir = (dir = limitsDir()) => `${dir}/proposals`;

export async function listProposals(dir = limitsDir()): Promise<Proposal[]> {
  const out: Proposal[] = [];
  try {
    for await (const e of Deno.readDir(proposalsDir(dir))) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      const p = await Deno.readTextFile(`${proposalsDir(dir)}/${e.name}`).then(JSON.parse).catch(() => null);
      if (p?.id) out.push(p as Proposal);
    }
  } catch { /* none yet */ }
  return out.sort((a, b) => a.created.localeCompare(b.created));
}

const writeProposal = async (p: Proposal, dir: string) => {
  await Deno.mkdir(proposalsDir(dir), { recursive: true });
  await Deno.writeTextFile(`${proposalsDir(dir)}/${p.id}.json`, JSON.stringify(p, null, 2) + "\n");
};

/** Raises a proposal. One pending proposal per (scope, routine/project, from, to): asking again returns it. */
export async function propose(
  i: Omit<Proposal, "id" | "created" | "status">,
  accounts: string[],
  dir = limitsDir(),
): Promise<Proposal> {
  if (!parseAccountId(i.to) || !accounts.includes(i.to)) throw new Error(`no account ${i.to}`);
  if (i.to === i.from) throw new Error("that is the account it has");
  if (i.scope === "routine" && !i.routine) throw new Error("a routine proposal names its routine");
  const same = (await listProposals(dir)).find((p) =>
    p.status === "pending" && p.scope === i.scope && p.project === i.project && p.routine === i.routine &&
    p.from === i.from && p.to === i.to
  );
  if (same) return same;
  const p: Proposal = {
    ...i,
    id: `p-${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "")}-${crypto.randomUUID().slice(0, 4)}`,
    created: new Date().toISOString(),
    status: "pending",
  };
  await writeProposal(p, dir);
  return p;
}

/** The owner's answer, carried by a coordinator or the CLI: accepted (the console applies it) or declined. */
export async function decide(id: string, accept: boolean, dir = limitsDir()): Promise<Proposal> {
  const p = (await listProposals(dir)).find((x) => x.id === id);
  if (!p) throw new Error(`no proposal ${id}`);
  if (p.status !== "pending") throw new Error(`proposal ${id} is already ${p.status}`);
  const next: Proposal = { ...p, status: accept ? "accepted" : "declined", decided: new Date().toISOString() };
  await writeProposal(next, dir);
  return next;
}

/** Marks an accepted proposal as applied. */
export const markApplied = (p: Proposal, dir = limitsDir()) => writeProposal({ ...p, status: "applied" }, dir);
