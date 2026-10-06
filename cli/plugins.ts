// plugins.ts — the plugin manager behind the console's Plugins view.
//
// Two owners, kept apart:
//   the repository decides which plugin is on where — `enabledPlugins` in shared/settings.json for
//     every profile, in profiles/<p>/settings.json for one (settings.ts), and the marketplaces in
//     shared `extraKnownMarketplaces`;
//   Claude Code owns the runtime — the plugin cache, the marketplace clones, installed_plugins.json —
//     and every change there goes through its own CLI (`claude plugin … --json`), never by editing
//     its files, so a format change on its side does not break this.
//
// The CLI also writes `enabledPlugins` into the profile's settings.json on its own. Every operation
// therefore (1) adopts what sessions wrote so far, (2) runs the CLI, (3) records the decision in the
// repository, (4) regenerates without adopting — the CLI's bookkeeping is replaced by the repo's.
// A marketplace-declared command (a command-source install) is never accepted here: it comes back
// to the page as `confirm`, and runs only when the person re-sends its sha256.

import { BIN, listDir, lstat, type Profile, profileNames, readJson, RUNTIME, STATE } from "./lib.ts";
import { editSettingsSource, expectedSettings, runtimePath, syncAllSettings, syncSettings } from "./settings.ts";
import { isObj, type Obj } from "./json-patch.ts";

const CLAUDE = `${BIN}/claude-bin`;
// Every value reaches `claude plugin` as an argument: one starting with "-" would be read as an
// option (`--claudeai`, `--scope`), so names start with a letter or digit and a source never with "-".
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const validSource = (s: string) => !!s && !s.startsWith("-") && !/\s/.test(s);

/** `claude plugin …` for one profile. cwd is the state dir so no project's .claude/ is read. */
async function claude(p: Profile, args: string[], timeoutMs = 180_000) {
  await Deno.mkdir(STATE, { recursive: true });
  const child = new Deno.Command(CLAUDE, {
    args,
    cwd: STATE,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { CLAUDE_CONFIG_DIR: `${RUNTIME}/${p}`, DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" },
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch { /* gone */ }
  }, timeoutMs);
  const r = await child.output();
  clearTimeout(timer);
  const dec = new TextDecoder();
  const out = dec.decode(r.stdout).trim(), err = dec.decode(r.stderr).trim();
  return { code: r.code, out, err, json: parseJson(out) };
}

/** Whole stdout as JSON, else its last line (`--json` prints one result line after any notice). */
export function parseJson(out: string): unknown {
  for (const s of [out, out.split("\n").filter(Boolean).pop() ?? ""]) {
    try {
      return JSON.parse(s);
    } catch { /* next */ }
  }
  return null;
}

/** Profiles that exist on this machine: an operation on "all" means these. */
async function livingProfiles(): Promise<Profile[]> {
  const out: Profile[] = [];
  for (const p of await profileNames()) if (await lstat(`${RUNTIME}/${p}`)) out.push(p);
  return out;
}

// One operation at a time: two installs racing over the same settings file would adopt each
// other's bookkeeping.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> {
  const next = chain.then(f, f);
  chain = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------- inventory
interface Installed {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
  installPath?: string;
}

export interface PluginCell {
  /** this profile's own entry in profiles/<p>/settings.json: true/false, null = removed, undefined = inherits */
  override?: boolean | null;
  /** what the generated settings say */
  enabled: boolean;
  installed: boolean;
  version?: string;
  /** installed, but its cache directory is gone: Claude reports it as failing to load */
  broken?: boolean;
}
export interface PluginRow {
  id: string;
  name: string;
  marketplace: string;
  /** synced into the account by the organisation: Account MCP governs it, not this page */
  synced: boolean;
  /** the entry in shared/settings.json, undefined when there is none */
  shared?: boolean;
  profiles: Record<Profile, PluginCell>;
}
export interface MarketplaceRow {
  name: string;
  source: string;
  declared: boolean;
  known: Profile[];
}

/** The table the page shows: every plugin the repository mentions or a profile has installed. */
export function plugTable(
  profiles: Profile[],
  shared: Obj,
  perProfile: Record<Profile, { patch: Obj; built: Obj; installed: Installed[] }>,
): PluginRow[] {
  const ep = (o: Obj) => isObj(o.enabledPlugins) ? o.enabledPlugins as Obj : {};
  const ids = new Set<string>(Object.keys(ep(shared)));
  for (const p of profiles) {
    for (const id of Object.keys(ep(perProfile[p].patch))) ids.add(id);
    for (const i of perProfile[p].installed) ids.add(i.id);
  }
  return [...ids].sort().map((id) => {
    const [name, marketplace = ""] = id.split("@");
    const sv = ep(shared)[id];
    const row: PluginRow = {
      id,
      name,
      marketplace,
      synced: marketplace === "synced",
      shared: typeof sv === "boolean" ? sv : undefined,
      profiles: {},
    };
    for (const p of profiles) {
      const { patch, built, installed } = perProfile[p];
      const inst = installed.find((i) => i.id === id);
      const ov = ep(patch)[id];
      row.profiles[p] = {
        override: ov === null ? null : typeof ov === "boolean" ? ov : undefined,
        enabled: ep(built)[id] === true,
        installed: !!inst,
        version: inst?.version,
      };
    }
    return row;
  });
}

export async function inventory() {
  const profiles = await livingProfiles();
  const { shared } = profiles.length ? await expectedSettings(profiles[0]) : { shared: {} as Obj };
  const perProfile: Record<Profile, { patch: Obj; built: Obj; installed: Installed[] }> = {};
  const known: Record<string, { source: string; profiles: Profile[] }> = {};
  const syncedSkills: Record<Profile, string[]> = {};
  await Promise.all(profiles.map(async (p) => {
    const [{ patch, built }, list, mk] = await Promise.all([
      expectedSettings(p),
      claude(p, ["plugin", "list", "--json"], 60_000),
      claude(p, ["plugin", "marketplace", "list", "--json"], 60_000),
    ]);
    const installed = Array.isArray(list.json) ? list.json as Installed[] : [];
    perProfile[p] = { patch, built, installed };
    for (const m of Array.isArray(mk.json) ? mk.json as Record<string, string>[] : []) {
      (known[m.name] ??= { source: m.repo ?? m.url ?? m.path ?? m.source ?? "", profiles: [] }).profiles.push(p);
    }
    syncedSkills[p] = await syncedSkillNames(`${RUNTIME}/${p}`);
  }));
  const plugins = plugTable(profiles, shared, perProfile);
  for (const row of plugins) {
    for (const p of profiles) {
      const inst = perProfile[p].installed.find((i) => i.id === row.id);
      if (inst?.installPath && !(await lstat(inst.installPath))) row.profiles[p].broken = true;
    }
  }
  const declared = isObj(shared.extraKnownMarketplaces) ? shared.extraKnownMarketplaces as Obj : {};
  const names = new Set([...Object.keys(declared), ...Object.keys(known)]);
  const marketplaces: MarketplaceRow[] = [...names].sort().map((name) => {
    const d = declared[name];
    const src = isObj(d) && isObj(d.source) ? d.source as Record<string, string> : null;
    return {
      name,
      source: src ? src.repo ?? src.url ?? src.path ?? "" : known[name]?.source ?? "",
      declared: !!d,
      known: known[name]?.profiles ?? [],
    };
  });
  return { profiles, plugins, marketplaces, syncedSkills };
}

/** Skills the claude.ai account syncs into a profile (skills/synced/<bucket>/<skill>/SKILL.md). */
async function syncedSkillNames(dir: string) {
  const out = new Set<string>();
  for (const b of await listDir(`${dir}/skills/synced`)) {
    for (const s of await listDir(`${dir}/skills/synced/${b}`)) {
      if (await lstat(`${dir}/skills/synced/${b}/${s}/SKILL.md`)) out.add(s);
    }
  }
  return [...out].sort();
}

// ---------------------------------------------------------------- catalog and details
export interface CatalogEntry {
  id: string;
  name: string;
  marketplace: string;
  description: string;
  installs: number;
}
let catalogCache: { at: number; entries: CatalogEntry[] } | null = null;

/** Everything the known marketplaces offer, across profiles (each knows its own marketplaces). */
export async function catalog(fresh = false): Promise<CatalogEntry[]> {
  if (!fresh && catalogCache && Date.now() - catalogCache.at < 10 * 60_000) return catalogCache.entries;
  const byId = new Map<string, CatalogEntry>();
  for (const p of await livingProfiles()) {
    const r = await claude(p, ["plugin", "list", "--available", "--json"], 120_000);
    const avail = isObj(r.json) && Array.isArray(r.json.available) ? r.json.available as Record<string, unknown>[] : [];
    for (const a of avail) {
      const id = String(a.pluginId ?? "");
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        name: String(a.name ?? id),
        marketplace: String(a.marketplaceName ?? ""),
        description: String(a.description ?? ""),
        installs: Number(a.installCount ?? 0),
      });
    }
  }
  catalogCache = { at: Date.now(), entries: [...byId.values()].sort((a, b) => b.installs - a.installs) };
  return catalogCache.entries;
}

/** `claude plugin details`: component inventory and projected token cost. */
export async function details(id: string) {
  if (!ID_RE.test(id)) throw new Error("invalid plugin id");
  const profiles = await livingProfiles();
  let where = profiles[0];
  for (const p of profiles) {
    const l = await claude(p, ["plugin", "list", "--json"], 60_000);
    if (Array.isArray(l.json) && (l.json as Installed[]).some((i) => i.id === id)) {
      where = p;
      break;
    }
  }
  const r = await claude(where, ["plugin", "details", id], 60_000);
  return r.out || r.err;
}

// ---------------------------------------------------------------- operations
export type PluginOp =
  | { op: "set"; id: string; target: "shared" | Profile; value: boolean | null }
  | { op: "install"; id: string; profiles: Profile[] | "all"; accept?: string }
  | { op: "uninstall"; id: string; profiles: Profile[] | "all" }
  | { op: "update"; id: string; accept?: string }
  | { op: "marketplace-add"; source: string }
  | { op: "marketplace-remove"; name: string }
  | { op: "marketplace-update"; name?: string };
export interface OpResult {
  ok: boolean;
  message: string;
  log: string[];
  confirm?: { command: string; sha256: string };
}

function setEnabled(o: Obj, id: string, value: boolean | null | undefined) {
  const ep = isObj(o.enabledPlugins) ? o.enabledPlugins as Obj : (o.enabledPlugins = {}) as Obj;
  if (value === undefined) delete ep[id];
  else ep[id] = value;
  if (!Object.keys(ep).length) delete o.enabledPlugins;
}

/** A marketplace-declared command the CLI wants a person to accept, if that is what it answered. */
export function pendingCommand(json: unknown): OpResult["confirm"] | undefined {
  if (!isObj(json)) return undefined;
  const sc = json.shownCommand;
  if (!isObj(sc) || typeof sc.sha256 !== "string") return undefined;
  if (json.outcome === "ok") return undefined;
  const cmd = typeof sc.command === "string"
    ? sc.command
    : Array.isArray(sc.argv)
    ? (sc.argv as string[]).join(" ")
    : JSON.stringify(sc);
  return { command: cmd, sha256: sc.sha256 };
}

const said = (r: { out: string; err: string; json: unknown }) =>
  isObj(r.json) && typeof r.json.message === "string"
    ? r.json.message
    : (r.err || r.out).split("\n").slice(-3).join(" ");

async function targets(spec: Profile[] | "all") {
  const living = await livingProfiles();
  if (spec === "all") return living;
  for (const p of spec) if (!living.includes(p)) throw new Error(`unknown profile: ${p}`);
  return spec;
}

/** The `claude plugin marketplace add` argument for a declared source. */
export function sourceArg(src: unknown): string | null {
  if (!isObj(src)) return null;
  const v = src.source === "github" ? src.repo : src.url ?? src.path ?? src.repo;
  return typeof v === "string" && v ? v : null;
}

/** A declared marketplace is registered in a profile only when a session starts there: a profile
 *  never opened (or opened before the declaration) does not know it yet, and cannot install from
 *  it. Register it first. */
async function ensureMarketplace(p: Profile, id: string, log: string[]) {
  const name = id.split("@")[1];
  const known = await readJson<Obj>(`${RUNTIME}/${p}/plugins/known_marketplaces.json`) ?? {};
  if (name in known) return;
  const { shared } = await expectedSettings(p);
  const decl = isObj(shared.extraKnownMarketplaces) ? (shared.extraKnownMarketplaces as Obj)[name] : undefined;
  const arg = sourceArg(isObj(decl) ? decl.source : undefined);
  if (!arg || !validSource(arg)) return; // not (validly) declared: the install will say what is missing
  const r = await claude(p, ["plugin", "marketplace", "add", arg]);
  log.push(`${p}: marketplace ${name} → ${said(r)}`);
}

async function installedIn(p: Profile, id: string) {
  const l = await claude(p, ["plugin", "list", "--json"], 60_000);
  return Array.isArray(l.json) && (l.json as Installed[]).some((i) => i.id === id);
}

export function pluginOp(op: PluginOp): Promise<OpResult> {
  return serial(() => runOp(op));
}

async function runOp(op: PluginOp): Promise<OpResult> {
  const log: string[] = [];
  const fail = (message: string, extra: Partial<OpResult> = {}): OpResult => ({ ok: false, message, log, ...extra });
  if ("id" in op && !ID_RE.test(op.id)) return fail("invalid plugin id (name@marketplace)");
  if ("accept" in op && op.accept !== undefined && !/^[0-9a-f]{64}$/i.test(op.accept)) {
    return fail("invalid command hash");
  }
  // (1) whatever sessions wrote so far becomes the repository's before anything else moves
  for (const r of await syncAllSettings()) {
    if (r.adopted.length) log.push(`${r.profile}: adopted ${r.adopted.join(", ")}`);
  }
  const regenerate = async () => {
    for (const p of await livingProfiles()) await syncSettings(p, { adopt: false });
  };

  switch (op.op) {
    case "set": {
      if (op.target !== "shared" && !(await livingProfiles()).includes(op.target)) {
        return fail(`unknown profile: ${op.target}`);
      }
      await editSettingsSource(op.target, (o) => setEnabled(o, op.id, op.value === null ? undefined : op.value));
      await syncAllSettings();
      // on now and not installed: install it right away instead of at the next session start —
      // only where this change reaches, so a click on one profile never installs on another
      for (const p of op.target === "shared" ? await livingProfiles() : [op.target]) {
        const { built } = await expectedSettings(p);
        const on = isObj(built.enabledPlugins) && (built.enabledPlugins as Obj)[op.id] === true;
        if (on && !(await installedIn(p, op.id))) {
          await ensureMarketplace(p, op.id, log);
          const r = await claude(p, ["plugin", "install", op.id, "--json"]);
          log.push(`${p}: install → ${said(r)}`);
          const c = pendingCommand(r.json);
          if (c) {
            await regenerate();
            return fail(`${op.id} needs a command accepted before it installs`, { confirm: c });
          }
        }
      }
      await regenerate();
      return {
        ok: true,
        message: `${op.id}: ${op.value === null ? "inherits shared" : op.value ? "on" : "off"} for ${op.target}`,
        log,
      };
    }
    case "install": {
      const ps = await targets(op.profiles);
      for (const p of ps) {
        await ensureMarketplace(p, op.id, log);
        const r = await claude(p, [
          "plugin",
          "install",
          op.id,
          "--json",
          ...(op.accept ? ["--accept-command", op.accept] : []),
        ]);
        log.push(`${p}: ${said(r)}`);
        const c = pendingCommand(r.json);
        if (c) {
          await regenerate();
          return fail(`${op.id} declares a command to run: accept it to install`, { confirm: c });
        }
        if (r.code !== 0) {
          await regenerate();
          return fail(`install failed on ${p}: ${said(r)}`);
        }
      }
      if (op.profiles === "all") {
        await editSettingsSource("shared", (o) => setEnabled(o, op.id, true));
        for (const p of ps) await editSettingsSource(p, (o) => setEnabled(o, op.id, undefined));
      } else {
        for (const p of ps) await editSettingsSource(p, (o) => setEnabled(o, op.id, true));
      }
      await regenerate();
      return { ok: true, message: `${op.id} installed on ${ps.join(", ")}`, log };
    }
    case "uninstall": {
      const ps = await targets(op.profiles);
      const { shared } = await expectedSettings(ps[0]);
      const onInShared = isObj(shared.enabledPlugins) && (shared.enabledPlugins as Obj)[op.id] === true;
      if (op.profiles === "all") {
        await editSettingsSource("shared", (o) => setEnabled(o, op.id, undefined));
        for (const p of ps) await editSettingsSource(p, (o) => setEnabled(o, op.id, undefined));
      } else {
        // shared still turns it on: this profile has to say false, or the next session reinstalls it
        for (const p of ps) await editSettingsSource(p, (o) => setEnabled(o, op.id, onInShared ? false : undefined));
      }
      for (const p of ps) {
        if (!(await installedIn(p, op.id))) continue;
        const r = await claude(p, ["plugin", "uninstall", op.id, "--json"]);
        log.push(`${p}: ${said(r)}`);
      }
      await regenerate();
      return { ok: true, message: `${op.id} removed from ${ps.join(", ")}`, log };
    }
    case "update": {
      for (const p of await livingProfiles()) {
        if (!(await installedIn(p, op.id))) continue;
        const r = await claude(p, [
          "plugin",
          "update",
          op.id,
          "--json",
          ...(op.accept ? ["--accept-command", op.accept] : []),
        ]);
        log.push(`${p}: ${said(r)}`);
        const c = pendingCommand(r.json);
        if (c) {
          await regenerate();
          return fail(`the update of ${op.id} declares a command to run: accept it to go on`, { confirm: c });
        }
      }
      await regenerate();
      return { ok: true, message: `${op.id} updated (restart the sessions to load it)`, log };
    }
    case "marketplace-add": {
      const source = op.source.trim();
      if (!validSource(source)) {
        return fail("a marketplace source is one URL, path or owner/repo, and does not start with -");
      }
      const ps = await livingProfiles();
      const knownNames = async (p: Profile) =>
        Object.keys(await readJson<Obj>(`${RUNTIME}/${p}/plugins/known_marketplaces.json`) ?? {});
      const before = new Set(await knownNames(ps[0]));
      const r = await claude(ps[0], ["plugin", "marketplace", "add", source]);
      log.push(`${ps[0]}: ${said(r)}`);
      const added = (await knownNames(ps[0])).filter((n) => !before.has(n));
      if (r.code !== 0 || added.length !== 1) {
        await regenerate();
        return fail(
          r.code !== 0 ? `marketplace add failed: ${said(r)}` : "no new marketplace appeared (already known?)",
        );
      }
      const name = added[0];
      // the declaration the CLI wrote into this profile's settings goes to shared, for every profile
      const written = await readJson<Obj>(runtimePath(ps[0]));
      const ekm = isObj(written?.extraKnownMarketplaces) ? (written!.extraKnownMarketplaces as Obj)[name] : undefined;
      const known = (await readJson<Obj>(`${RUNTIME}/${ps[0]}/plugins/known_marketplaces.json`))?.[name];
      const decl = isObj(ekm) ? ekm : isObj(known) && isObj(known.source) ? { source: known.source } : null;
      if (!decl) {
        await regenerate();
        return fail(`added ${name}, but its source could not be read back`);
      }
      await editSettingsSource("shared", (o) => {
        const m = isObj(o.extraKnownMarketplaces)
          ? o.extraKnownMarketplaces as Obj
          : (o.extraKnownMarketplaces = {}) as Obj;
        m[name] = decl;
      });
      for (const p of ps.slice(1)) {
        const r2 = await claude(p, ["plugin", "marketplace", "add", source]);
        log.push(`${p}: ${said(r2)}`);
      }
      await regenerate();
      catalogCache = null;
      return { ok: true, message: `marketplace ${name} added for every profile`, log };
    }
    case "marketplace-remove": {
      if (!NAME_RE.test(op.name)) return fail("invalid marketplace name");
      const ps = await livingProfiles();
      const dropFrom = (o: Obj) => {
        if (isObj(o.extraKnownMarketplaces)) {
          delete (o.extraKnownMarketplaces as Obj)[op.name];
          if (!Object.keys(o.extraKnownMarketplaces).length) delete o.extraKnownMarketplaces;
        }
        if (isObj(o.enabledPlugins)) {
          for (const id of Object.keys(o.enabledPlugins)) {
            if (id.endsWith(`@${op.name}`)) setEnabled(o, id, undefined);
          }
        }
      };
      await editSettingsSource("shared", dropFrom);
      for (const p of ps) await editSettingsSource(p, dropFrom);
      for (const p of ps) {
        const r = await claude(p, ["plugin", "marketplace", "remove", op.name]);
        log.push(`${p}: ${said(r)}`);
      }
      await regenerate();
      catalogCache = null;
      return { ok: true, message: `marketplace ${op.name} removed, with its plugins`, log };
    }
    case "marketplace-update": {
      if (op.name && !NAME_RE.test(op.name)) return fail("invalid marketplace name");
      for (const p of await livingProfiles()) {
        const r = await claude(p, ["plugin", "marketplace", "update", ...(op.name ? [op.name] : [])]);
        log.push(`${p}: ${said(r)}`);
      }
      await regenerate();
      catalogCache = null;
      return { ok: true, message: `${op.name ?? "every marketplace"} updated`, log };
    }
  }
}
