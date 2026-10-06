// permissions.ts — the permission rules, as System › Permissions shows and edits them.
//
// What every profile gets is the repository's base (shared/settings.json, the safety rules) with the
// person's settings over it (config/settings.json, settings.ts: sharedLayer). A profile's patch
// (config/profiles/<p>/settings.json)
// can hold its own lists, and a list there replaces the shared one whole (settings.ts: a JSON Merge
// Patch compares arrays whole). That is also where "always allow" answers land, adopted from what
// Claude writes into a profile's generated settings. So what matters for a profile is how its list
// differs from the shared one: the rules it adds, and the shared rules it drops.
//
// Writes go to the person's configuration; each profile's settings.json is regenerated from it on the next
// launch (bin/lib/prelaunch.sh), so a change applies from the next session.

import { profileNames, PROFILES, readJson } from "./lib.ts";
import { sharedLayer, writeSharedLayer } from "./settings.ts";
import type { Obj } from "./json-patch.ts";

export const LISTS = ["allow", "ask", "deny"] as const;
export type List = typeof LISTS[number];
export type Rules = Record<List, string[]>;
const patchOf = (p: string) => `${PROFILES}/${p}/settings.json`;

/** Pure: a rule Claude Code understands — a tool name, optionally with a specifier in parentheses
 *  (`Bash(git:*)`, `Read(~/.aws/**)`, `mcp__n8n__n8n_workflows`, `WebFetch(domain:example.com)`). */
export function validRule(r: string): boolean {
  return /^[A-Za-z][\w-]*(\(.+\))?$/.test(r.trim()) && r.trim().length <= 300;
}

/** Pure: what a profile's own list adds to the shared one, and which shared rules it leaves out. */
export function ruleDiff(shared: string[], own: string[] | undefined): { added: string[]; dropped: string[] } | null {
  if (!own) return null;
  const s = new Set(shared), o = new Set(own);
  return { added: own.filter((r) => !s.has(r)), dropped: shared.filter((r) => !o.has(r)) };
}

type Settings = { permissions?: Partial<Rules> & { defaultMode?: string } } & Record<string, unknown>;

export async function permissionsView() {
  const shared = await sharedLayer() as Settings;
  const sp = shared.permissions ?? {};
  const rules = Object.fromEntries(LISTS.map((l) => [l, sp[l] ?? []])) as Rules;
  const profiles: Record<
    string,
    { mode?: string; lists: Partial<Record<List, { added: string[]; dropped: string[] }>> }
  > = {};
  for (const p of await profileNames()) {
    const pp = (await readJson<Settings>(patchOf(p)))?.permissions ?? {};
    const lists: Partial<Record<List, { added: string[]; dropped: string[] }>> = {};
    for (const l of LISTS) {
      const d = ruleDiff(rules[l], pp[l]);
      if (d && (d.added.length || d.dropped.length)) lists[l] = d;
    }
    profiles[p] = { ...(pp.defaultMode ? { mode: pp.defaultMode } : {}), lists };
  }
  return { mode: sp.defaultMode ?? "default", rules, profiles };
}

async function write(path: string, data: unknown) {
  await Deno.writeTextFile(path, JSON.stringify(data, null, 2) + "\n");
}

export type PermOp =
  | { op: "add" | "remove"; list: List; rule: string }
  | { op: "mode"; mode: string }
  | { op: "promote"; profile: string };

export async function permissionsOp(b: PermOp): Promise<{ ok: boolean; message: string }> {
  const shared = await sharedLayer() as Settings;
  const perms = shared.permissions ??= {};
  if (b.op === "mode") {
    if (!["default", "acceptEdits", "plan", "auto"].includes(b.mode)) {
      return { ok: false, message: `unknown mode ${b.mode}` };
    }
    perms.defaultMode = b.mode;
    await writeSharedLayer(shared as Obj);
    return { ok: true, message: `default mode: ${b.mode}` };
  }
  if (b.op === "add" || b.op === "remove") {
    if (!LISTS.includes(b.list)) return { ok: false, message: "unknown list" };
    const rule = String(b.rule ?? "").trim();
    const list = perms[b.list] ??= [];
    if (b.op === "add") {
      if (!validRule(rule)) return { ok: false, message: `not a rule Claude Code reads: ${rule}` };
      // one rule lives in one list: the same rule in allow and deny would depend on precedence
      for (const l of LISTS) {
        if (l !== b.list && perms[l]?.includes(rule)) return { ok: false, message: `${rule} is already in ${l}` };
      }
      if (!list.includes(rule)) list.push(rule);
    } else {
      const i = list.indexOf(rule);
      if (i < 0) return { ok: false, message: `${rule} is not in ${b.list}` };
      list.splice(i, 1);
    }
    await writeSharedLayer(shared as Obj);
    return { ok: true, message: `${b.op === "add" ? "added to" : "removed from"} ${b.list}: ${rule}` };
  }
  if (b.op === "promote") {
    if (!(await profileNames()).includes(b.profile)) return { ok: false, message: "unknown profile" };
    const patch = await readJson<Settings>(patchOf(b.profile));
    const pp = patch?.permissions;
    if (!patch || !pp) return { ok: true, message: "nothing to move" };
    let moved = 0;
    for (const l of LISTS) {
      if (!pp[l]) continue;
      const list = perms[l] ??= [];
      for (const r of pp[l]!) {
        if (!list.includes(r) && !LISTS.some((o) => o !== l && perms[o]?.includes(r))) {
          list.push(r);
          moved++;
        }
      }
      delete pp[l];
    }
    if (!Object.keys(pp).length) delete patch.permissions;
    await writeSharedLayer(shared as Obj);
    await write(patchOf(b.profile), patch);
    return { ok: true, message: `${moved} rules moved from ${b.profile} to every profile` };
  }
  return { ok: false, message: "unknown operation" };
}
