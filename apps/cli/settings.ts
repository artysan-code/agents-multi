// settings.ts — each profile's settings.json is generated, not linked.
//
//   shared/settings.json            the setup's own: hooks, statusline, the safety rules (repository)
//   config/settings.json            the person's: what every profile of theirs gets, as a JSON
//                                   Merge Patch over the above (RFC 7386: objects merge, anything
//                                   else replaces, null deletes the key)
//   config/profiles/<p>/settings.json   that profile's differences, a merge patch over both
//   the manifest                    what it implies (disableAccountMcp)
//     → ~/.agents-multi/<p>/settings.json
//
// Claude Code writes into its settings.json (/plugin, /config, "always allow"): those writes land in
// the generated file. Before regenerating, the difference between the file and the last generated
// copy (kept in XDG state, per machine) is adopted into the profile's patch — nothing Claude wrote
// is lost, and it stays with the profile it was written in. Moving a change to every profile means
// moving it into the person's config/settings.json ("shared" below: base ⊕ person).
//
// Plugins are why this exists: Claude Code installs every plugin `enabledPlugins` marks true when a
// session starts, so a plugin is off for one profile only if that profile's own file says false.

import { permissionRules, type RegistryRules } from "./mcp/placement.ts";
import { loadRegistry } from "./mcp/registry.ts";
import { lstat, readJson } from "./lib/fs.ts";
import { CONFIG, PROFILES, REPO, RUNTIME, STAMP, STATE } from "./lib/paths.ts";
import { syncedPlugins } from "./lib/plugins.ts";
import { loadManifest, type Manifest, type Profile, profileNames } from "./lib/profiles.ts";
import { diffPatch, isObj, type Json, mergePatch, type Obj, same } from "./lib/json-patch.ts";

/** What the manifest implies. disableAccountMcp: connectors off, every synced plugin disabled —
 *  here it reaches Desktop's Code tab too, which the launcher's --settings overlay cannot. */
export function manifestPatch(m: Pick<Manifest, "disableAccountMcp">, synced: string[]): Obj {
  if (!m.disableAccountMcp) return {};
  return { disableClaudeAiConnectors: true, enabledPlugins: Object.fromEntries(synced.map((id) => [id, false])) };
}

type Rules = RegistryRules;
const isGenerated = (rules: Rules, h: Json) => rules.hooks.some((g) => same(g, h));

/** What the MCP registry implies (`_deny`, `_ask`, `_guard`): its rules added to the permission
 *  lists and its guards to the PreToolUse hooks the profile already has. Added, not replacing: a
 *  merge patch replaces arrays whole, so the derived list carries the base one with it. */
export function registryPatch(base: Obj, rules: Rules): Obj {
  const perms = isObj(base.permissions) ? base.permissions : {};
  const permissions: Obj = {};
  for (const k of ["deny", "ask"] as const) {
    if (!rules[k].length) continue;
    const have = Array.isArray(perms[k]) ? perms[k] as Json[] : [];
    permissions[k] = [...have, ...rules[k].filter((r) => !have.includes(r))];
  }
  const out: Obj = {};
  if (Object.keys(permissions).length) out.permissions = permissions;
  if (rules.hooks.length) {
    const have = isObj(base.hooks) && Array.isArray(base.hooks.PreToolUse) ? base.hooks.PreToolUse : [];
    out.hooks = {
      PreToolUse: [...have, ...rules.hooks.filter((h) => !have.some((x) => same(x, h))) as unknown as Json[]],
    };
  }
  return out;
}

/** A patch without the rules the registry generates: they are rebuilt from it every time, and an
 *  adopted copy in the repository would outlive the server they were for. */
export function withoutRules(shared: Obj, patch: Obj, rules: Rules): Obj {
  const p: Obj = structuredClone(patch);
  if (isObj(p.permissions)) {
    const pp = p.permissions;
    for (const k of ["deny", "ask"] as const) {
      if (Array.isArray(pp[k])) pp[k] = (pp[k] as Json[]).filter((r) => !rules[k].includes(r as string));
    }
  }
  if (isObj(p.hooks) && Array.isArray(p.hooks.PreToolUse)) {
    p.hooks.PreToolUse = p.hooks.PreToolUse.filter((h) => !isGenerated(rules, h));
  }
  return diffPatch(shared, mergePatch(shared, p) as Obj);
}

/** shared ⊕ profile patch ⊕ manifest. */
export function buildSettings(shared: Obj, patch: Obj, derived: Obj): Obj {
  return mergePatch(mergePatch(shared, patch), derived) as Obj;
}

/** Fold what Claude wrote (the difference between the last generated file and the current one)
 *  into the profile patch. The difference is applied to the current shared ⊕ patch, so a shared
 *  change pulled since the last build is not undone. The result is kept minimal against the base:
 *  an entry that says what shared already says is dropped, so reverting a change in a session also
 *  clears it from the repository. A write to a key the manifest derives is kept, but the manifest
 *  still wins on every build. */
export function adopt(shared: Obj, patch: Obj, lastBuilt: Obj, current: Obj): { patch: Obj; changed: string[] } {
  const d = diffPatch(lastBuilt, current);
  const changed = paths(d);
  if (!changed.length) return { patch, changed };
  // the effective settings the user now has, minus the base, is the new patch
  const effective = mergePatch(mergePatch(shared, patch), d) as Obj;
  return { patch: diffPatch(shared, effective), changed };
}

/** Dotted leaf paths of a patch, for reporting ("enabledPlugins.context7@claude-plugins-official"). */
export function paths(p: Obj, prefix = ""): string[] {
  return Object.entries(p).flatMap(([k, v]) =>
    isObj(v) && Object.keys(v).length ? paths(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  );
}

// ---------------------------------------------------------------- files
const BASE_SETTINGS = `${REPO}/shared/settings.json`;
const PERSON_SETTINGS = `${CONFIG}/settings.json`;
const patchPath = (p: Profile) => `${PROFILES}/${p}/settings.json`;
export const runtimePath = (p: Profile) => `${RUNTIME}/${p}/settings.json`;
const builtPath = (p: Profile) => `${STATE}/settings/${p}.json`;

async function readObj(path: string): Promise<Obj | null> {
  const v = await readJson<Json>(path);
  return isObj(v) ? v : null;
}
async function writeJson(path: string, v: Json) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  const tmp = `${path}.tmp-${Deno.pid}`;
  await Deno.writeTextFile(tmp, JSON.stringify(v, null, 2) + "\n");
  await Deno.rename(tmp, path);
}

interface SettingsResult {
  profile: Profile;
  /** paths adopted from Claude's writes into profiles/<p>/settings.json */
  adopted: string[];
  /** the runtime file was (or, dry, would be) rewritten */
  wrote: boolean;
  /** it was still a symlink to shared/settings.json */
  migrated: boolean;
  /** a regular file with no record of what was generated: kept aside, not adopted */
  orphan?: string;
}

/** What every profile gets: the repository's base with the person's settings over it. */
export async function sharedLayer(): Promise<Obj> {
  return mergePatch(await readObj(BASE_SETTINGS) ?? {}, await readObj(PERSON_SETTINGS) ?? {}) as Obj;
}
/** Keep `layer` as what every profile gets: the person's file becomes its difference from the base. */
export async function writeSharedLayer(layer: Obj) {
  await writeJson(PERSON_SETTINGS, diffPatch(await readObj(BASE_SETTINGS) ?? {}, layer));
}

/** The inputs and the expected file for one profile, without touching anything. */
export async function expectedSettings(p: Profile) {
  const shared = await sharedLayer();
  const patch = await readObj(patchPath(p)) ?? {};
  const rules = await registryRules(p);
  const fromManifest = manifestPatch(await loadManifest(p), await syncedPlugins(`${RUNTIME}/${p}`));
  const derived = derive(fromManifest, shared, patch, rules);
  return { shared, patch, fromManifest, derived, rules, built: buildSettings(shared, patch, derived) };
}

/** manifest ⊕ registry, the registry's rules added to the lists shared ⊕ patch has. */
function derive(fromManifest: Obj, shared: Obj, patch: Obj, rules: Rules): Obj {
  return mergePatch(fromManifest, registryPatch(mergePatch(shared, patch) as Obj, rules)) as Obj;
}

async function registryRules(p: Profile): Promise<Rules> {
  try {
    return permissionRules(await loadRegistry(), p);
  } catch {
    return { deny: [], ask: [], hooks: [] };
  } // no registry: the doctor says so
}

/**
 * Regenerate one profile's settings.json. With `adopt`, Claude's writes since the last build are
 * first folded into the profile patch (repository); without it they are discarded — used right
 * after the console ran a `claude plugin` command whose effect is already recorded in the repo.
 */
export async function syncSettings(p: Profile, opts: { adopt?: boolean; dry?: boolean } = {}): Promise<SettingsResult> {
  const adoptWrites = opts.adopt ?? true;
  const res: SettingsResult = { profile: p, adopted: [], wrote: false, migrated: false };
  const rt = runtimePath(p);
  const st = await lstat(rt);
  res.migrated = !!st?.isSymlink;
  const current = st && !st.isSymlink ? await readObj(rt) : null;
  const lastBuilt = await readObj(builtPath(p));

  let { shared, patch, derived, rules, fromManifest } = await expectedSettings(p);
  if (current && lastBuilt && adoptWrites) {
    const a = adopt(shared, patch, lastBuilt, current);
    if (a.changed.length) {
      res.adopted = a.changed;
      patch = withoutRules(shared, a.patch, rules);
      derived = derive(fromManifest, shared, patch, rules);
      if (!opts.dry) {
        if (Object.keys(patch).length) await writeJson(patchPath(p), patch);
        else if (await lstat(patchPath(p))) await Deno.remove(patchPath(p));
      }
    }
  } else if (current && !lastBuilt && !same(current, buildSettings(shared, patch, derived))) {
    // A real file nobody recorded generating (state wiped, or hand-made): what in it is Claude's
    // cannot be told apart from what is stale, so it is kept aside rather than guessed at.
    res.orphan = `${STATE}/settings/${p}.orphan-${STAMP}.json`;
    if (!opts.dry) await writeJson(res.orphan, current);
  }

  const built = buildSettings(shared, patch, derived);
  res.wrote = res.migrated || !current || !same(current, built);
  if (opts.dry) return res;
  if (res.migrated) await Deno.remove(rt);
  if (res.wrote) await writeJson(rt, built);
  if (!same(lastBuilt, built)) await writeJson(builtPath(p), built);
  return res;
}

export async function syncAllSettings(opts: { adopt?: boolean; dry?: boolean } = {}) {
  const out: SettingsResult[] = [];
  for (const p of await profileNames()) {
    if (!(await lstat(`${RUNTIME}/${p}`))) continue; // not materialised yet: install creates it first
    out.push(await syncSettings(p, opts));
  }
  return out;
}

/** State of one profile's file, for the doctor: generated and current, Claude wrote into it since,
 *  or the inputs moved on and it has not been regenerated. */
export async function settingsState(
  p: Profile,
): Promise<{ kind: "symlink" | "missing" | "ok" | "local-writes" | "stale"; changed: string[] }> {
  const st = await lstat(runtimePath(p));
  if (!st) return { kind: "missing", changed: [] };
  if (st.isSymlink) return { kind: "symlink", changed: [] };
  const current = await readObj(runtimePath(p)) ?? {};
  const lastBuilt = await readObj(builtPath(p));
  if (lastBuilt && !same(current, lastBuilt)) {
    return { kind: "local-writes", changed: paths(diffPatch(lastBuilt, current)) };
  }
  const { built } = await expectedSettings(p);
  if (!same(current, built)) return { kind: "stale", changed: paths(diffPatch(current, built)) };
  return { kind: "ok", changed: [] };
}

/** Read-modify-write of a settings source in the repository (shared, or a profile's patch). */
export async function editSettingsSource(target: "shared" | Profile, edit: (o: Obj) => void) {
  if (target === "shared") {
    // edited as what every profile gets, kept as the person's difference from the repository's base
    const o = await sharedLayer();
    const before = JSON.stringify(o);
    edit(o);
    if (JSON.stringify(o) === before) return false;
    await writeSharedLayer(o);
    return true;
  }
  const path = patchPath(target);
  const o = await readObj(path) ?? {};
  const before = JSON.stringify(o);
  edit(o);
  if (JSON.stringify(o) === before) return false;
  if (target !== "shared" && !Object.keys(o).length) {
    if (await lstat(path)) await Deno.remove(path);
    return true;
  }
  await writeJson(path, o); // 2-space JSON, as Claude Code itself writes it
  return true;
}
