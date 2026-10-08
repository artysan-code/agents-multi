// setup.ts — the first-run wizard's server side (the console's /api/setup/*, console/setup.ts): where
// a new person is in their setup, read from the filesystem, and the steps that move it, each a thin
// wrapper over what the CLI already does (`agents init`, the profile manifests, the vault, Claude
// Code's sign-in, the brain's). Install itself is a job of the console (`install --app`, or `install`
// from a checkout), streamed to the page like the update screen's.
//
// The wizard is shown while the machine has no configuration, or while a setup it started is not
// finished. What each step leaves behind says whether it is done, so a crash or a closed window
// resumes at the first step whose result is missing. The few steps that leave nothing of their own
// (the welcome, profiles confirmed, the recovery code saved, a step put off for later) are recorded in
// `setup.json` in the state folder, with the name and language asked before a configuration exists.
//
// Once the setup is finished — or on a machine configured without it — every write here is refused:
// none of these endpoints is a way into a running installation.

import { lstat, readJson, readlink, readText } from "./lib/fs.ts";
import { BIN, CONFIG, HOME, REPO, RUNTIME, shortHome, STATE } from "./lib/paths.ts";
import { commandOf, type Manifest } from "./lib/profiles.ts";
import { idFrom } from "./init.ts";
import { readBuild } from "./appcopy.ts";
import { getSecret, keyMatches, loadKey, vaultDir } from "../../shared/mcp/lib/vault.ts";
import type { Account } from "../../shared/mcp/lib/accounts.ts";

const SETUP_STEPS = [
  "welcome",
  "you",
  "folder",
  "profiles",
  "install",
  "claude",
  "vault",
  "logins",
  "brain",
  "done",
] as const;
export type SetupStep = typeof SETUP_STEPS[number];

/** Steps the page may record as passed without a file of their own: the welcome, the profiles
 *  confirmed, Claude Code put off (installed some other way later), the recovery code saved (or the
 *  vault put off), the sign-ins and the brain put off. */
const PASSABLE: readonly SetupStep[] = ["welcome", "profiles", "claude", "vault", "logins", "brain"];

/** What the wizard keeps of its own, in `setup.json`. */
export interface SetupRecord {
  started: string;
  /** the name and language asked before the configuration exists (`init` writes them) */
  owner?: { name: string; language: string };
  /** steps passed by a confirmation or a «later» */
  passed: SetupStep[];
  /** of those, the ones put off: the summary says so */
  later: SetupStep[];
  /** the configuration was made here by the wizard, not linked from another machine: only then may the
   *  profiles step remove one of its profiles */
  created?: boolean;
  finished?: string;
}

export type VaultState = "ok" | "none" | "locked" | "wrong-key" | "unavailable";

/** What the filesystem says about the setup. */
export interface SetupFacts {
  /** a configuration is linked: `~/.agents-multi/config/owner.json` */
  configured: boolean;
  owner: { id: string; name: string; language: string } | null;
  /** the folder the configuration link points to */
  folder: string | null;
  profiles: { profile: string; command: string; installed: boolean; signedIn: boolean }[];
  /** the runtime's `shared` link and every profile's launcher and folder are there */
  installed: boolean;
  /** Claude Code's binary, which every launcher runs (`~/.local/bin/claude-bin`) */
  claudeCode: boolean;
  vault: VaultState;
  brain: { url: string | null; connected: boolean };
  record: SetupRecord | null;
}

/** Where the setup reads and writes: the real places, or a test's. */
export interface SetupPaths {
  home: string;
  config: string;
  runtime: string;
  bin: string;
  state: string;
}
export const SETUP_PATHS: SetupPaths = { home: HOME, config: CONFIG, runtime: RUNTIME, bin: BIN, state: STATE };

const recordFile = (p: SetupPaths) => `${p.state}/setup.json`;

/** Pure: whether the console opens on the wizard. */
export function setupActive(f: Pick<SetupFacts, "configured" | "record">): boolean {
  return !f.configured || (!!f.record && !f.record.finished);
}

/** Whether the wizard's writes are open: the same rule as the page's, from the two files it rests on
 *  (no keyring asked, no profile read). */
export async function setupOpen(p = SETUP_PATHS): Promise<boolean> {
  return setupActive({ configured: !!(await lstat(`${p.config}/owner.json`)), record: await readRecord(p) });
}

/** Pure: the first step whose result is missing. */
export function nextStep(f: SetupFacts): SetupStep {
  const r = f.record, passed = new Set(r?.passed ?? []);
  if (!r || !passed.has("welcome")) return "welcome";
  if (!f.owner && !r.owner) return "you";
  if (!f.configured) return "folder";
  if (!f.profiles.length || (!f.installed && !passed.has("profiles"))) return "profiles";
  if (!f.installed) return "install";
  if (!f.claudeCode && !passed.has("claude")) return "claude";
  if (!passed.has("vault")) return "vault";
  if (!passed.has("logins") && f.profiles.some((p) => !p.signedIn)) return "logins";
  if (!passed.has("brain") && !f.brain.connected) return "brain";
  return "done";
}

/** Pure: a profile list the wizard can write, or why not. Names are folders, commands are links in
 *  ~/.local/bin: both have a fixed shape, are unique, and a command never takes the name of one of
 *  the programs install links there (`reserved`). */
export function checkProfiles(
  list: { name?: unknown; command?: unknown }[],
  reserved: string[],
): { ok: true; profiles: { name: string; command: string }[] } | { ok: false; message: string } {
  if (!Array.isArray(list) || !list.length) return { ok: false, message: "at least one profile" };
  if (list.length > 8) return { ok: false, message: "at most eight profiles here; more later in System › Profiles" };
  const out: { name: string; command: string }[] = [];
  for (const e of list) {
    const name = String(e?.name ?? "").trim(), command = String(e?.command ?? "").trim() || `claude-${name}`;
    if (!/^[a-z][a-z0-9_-]{1,30}$/.test(name)) {
      return { ok: false, message: `«${name}»: a name is lowercase letters, digits, - or _, starting with a letter` };
    }
    if (!/^[a-z][a-z0-9_-]{0,40}$/.test(command)) {
      return { ok: false, message: `«${command}»: a command is lowercase letters, digits, - or _` };
    }
    if (command !== "claude" && reserved.includes(command)) {
      return { ok: false, message: `«${command}» is one of Agents Multi's own commands` };
    }
    if (out.some((o) => o.name === name)) return { ok: false, message: `«${name}» twice` };
    if (out.some((o) => o.command === command)) return { ok: false, message: `the command «${command}» twice` };
    out.push({ name, command });
  }
  return { ok: true, profiles: out };
}

/** Pure: the configuration folder the page asked for, as an absolute path inside the home folder,
 *  or why not. */
export function checkFolder(folder: unknown, home: string): { ok: true; dir: string } | { ok: false; message: string } {
  const raw = String(folder ?? "").trim().replace(/\/+$/, "");
  if (!raw) return { ok: false, message: "a folder" };
  const dir = raw === "~" ? home : raw.startsWith("~/") ? `${home}/${raw.slice(2)}` : raw;
  if (!dir.startsWith("/")) return { ok: false, message: "a full path, or one starting with ~/" };
  if (dir.split("/").some((s) => s === ".." || s === ".")) return { ok: false, message: "no . or .. in the path" };
  if (dir === home || !dir.startsWith(`${home}/`)) return { ok: false, message: "a folder inside your home folder" };
  return { ok: true, dir };
}

/** Pure: a brain's address, as the origin accounts.json keeps (https, or http on this machine). */
export function checkBrainUrl(url: unknown): { ok: true; url: string } | { ok: false; message: string } {
  try {
    const u = new URL(String(url ?? "").trim());
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
      return { ok: false, message: "the brain's address starts with https://" };
    }
    return { ok: true, url: u.origin };
  } catch {
    return { ok: false, message: "the address is not a valid URL" };
  }
}

/** This machine's vault, without throwing: whether it exists, and whether this machine opens it. */
async function vaultState(): Promise<VaultState> {
  const exists = !!(await readText(`${vaultDir()}/key-check.json`));
  try {
    const key = await loadKey();
    // a key with no vault next to it opens a new one: as good as none until `init` writes the check
    if (!exists) return "none";
    return (await keyMatches(key)) ? "ok" : "wrong-key";
  } catch (e) {
    if (/cannot be reached/.test((e as Error).message)) return "unavailable";
    return exists ? "locked" : "none";
  }
}

export async function readRecord(p = SETUP_PATHS): Promise<SetupRecord | null> {
  const r = await readJson<Partial<SetupRecord>>(recordFile(p));
  if (!r?.started) return null;
  return { ...r, started: r.started, passed: r.passed ?? [], later: r.later ?? [] };
}

async function writeRecord(r: SetupRecord, p = SETUP_PATHS) {
  await Deno.mkdir(p.state, { recursive: true });
  await Deno.writeTextFile(recordFile(p), JSON.stringify(r, null, 2) + "\n");
}

/** Changes the record (made on first use). */
export async function updateRecord(change: (r: SetupRecord) => void, p = SETUP_PATHS): Promise<SetupRecord> {
  const r = await readRecord(p) ?? { started: new Date().toISOString(), passed: [], later: [] };
  change(r);
  r.passed = [...new Set(r.passed)];
  r.later = [...new Set(r.later)];
  await writeRecord(r, p);
  return r;
}

/** The profiles declared in a configuration, with their launcher command. */
async function declared(config: string): Promise<{ profile: string; command: string }[]> {
  const out: { profile: string; command: string }[] = [];
  let names: string[] = [];
  try {
    names = [...Deno.readDirSync(`${config}/profiles`)].filter((e) => e.isDirectory).map((e) => e.name).sort();
  } catch { /* no profiles yet */ }
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const m = await readJson<Manifest>(`${config}/profiles/${n}/profile.json`);
    if (m) out.push({ profile: n, command: commandOf(n, m) });
  }
  return out;
}

/** What the filesystem says, with the vault and its secrets asked through `io` (a test's stubs). */
export async function setupFacts(
  p = SETUP_PATHS,
  io: { vault: () => Promise<VaultState>; hasSecret: (service: string, account: string) => Promise<boolean> } = {
    vault: vaultState,
    hasSecret: async (s, a) => !!(await getSecret(s, a).catch(() => null)),
  },
): Promise<SetupFacts> {
  const ownerFile = await readJson<{ id?: string; name?: string; language?: string }>(`${p.config}/owner.json`);
  const configured = !!ownerFile;
  const link = await readlink(p.config);
  const profiles = [];
  for (const d of configured ? await declared(p.config) : []) {
    const dir = `${p.runtime}/${d.profile}`;
    profiles.push({
      ...d,
      installed: !!(await lstat(dir)) && !!(await lstat(`${p.bin}/${d.command}`)),
      signedIn: !!(await lstat(`${dir}/.credentials.json`)),
    });
  }
  const shared = await lstat(`${p.runtime}/shared`);
  const vault = configured ? await io.vault() : "none";
  const accounts = (await readJson<{ accounts?: Account[] }>(`${p.config}/accounts.json`))?.accounts ?? [];
  const brain = accounts.find((a) => a.service === "brain" && !!a.url && !a.profiles?.length) ??
    accounts.find((a) => a.service === "brain" && !!a.url);
  return {
    configured,
    owner: ownerFile
      ? { id: ownerFile.id ?? "", name: ownerFile.name ?? "", language: ownerFile.language ?? "" }
      : null,
    folder: link ? (link.startsWith("/") ? link : `${p.config.slice(0, p.config.lastIndexOf("/"))}/${link}`) : null,
    profiles,
    installed: !!shared?.isSymlink && profiles.length > 0 && profiles.every((x) => x.installed),
    claudeCode: !!(await Deno.stat(`${p.bin}/claude-bin`).catch(() => null)),
    vault,
    brain: {
      url: brain?.url ?? null,
      connected: !!brain && vault === "ok" && await io.hasSecret("brain", brain.name),
    },
    record: await readRecord(p),
  };
}

/** The install the wizard runs: the app's (`install --app`, from the package's code, which carries a
 *  build.json) or a checkout's (`install`). Both are allowlisted actions of the console. */
async function installAction(repo = REPO): Promise<"install-app" | "install"> {
  return (await readBuild(repo)) ? "install-app" : "install";
}

/** What GET /api/setup answers. Asked by every page that opens, so a machine whose setup is over gets
 *  only that, without the keyring or the vault being touched. */
export async function setupView(p = SETUP_PATHS) {
  if (!(await setupOpen(p))) return { active: false };
  const facts = await setupFacts(p);
  return {
    active: setupActive(facts),
    step: nextStep(facts),
    facts: { ...facts, folder: facts.folder ? shortHome(facts.folder) : null },
    /** where the configuration goes when the person has no preference */
    suggested: "~/agents-multi-config",
    install: await installAction(),
    vaultDir: shortHome(vaultDir()),
  };
}

/** The new owner's name and language: into owner.json once there is one, else kept for `init`. */
export async function setOwner(b: { name?: unknown; language?: unknown }, p = SETUP_PATHS) {
  const name = String(b.name ?? "").trim().slice(0, 80), language = String(b.language ?? "").trim().slice(0, 40);
  if (!name) return { ok: false, message: "a name" };
  if (!language) return { ok: false, message: "a language" };
  const file = `${p.config}/owner.json`;
  const cur = await readJson<Record<string, unknown>>(file);
  if (cur) await Deno.writeTextFile(file, JSON.stringify({ ...cur, name, language }, null, 2) + "\n");
  await updateRecord((r) => r.owner = { name, language }, p);
  return { ok: true };
}

/** `agents init <folder>` with the name and language given: a new configuration, or one that is
 *  already there (another machine's, through Syncthing) only linked. */
export async function setFolder(
  b: { folder?: unknown },
  init: (args: string[], config: string) => Promise<number>,
  p = SETUP_PATHS,
): Promise<{ ok: boolean; message?: string; existing?: boolean }> {
  const f = checkFolder(b.folder, p.home);
  if (!f.ok) return f;
  const cur = await lstat(p.config);
  if (cur && !cur.isSymlink) {
    return { ok: false, message: `${shortHome(p.config)} exists and is not a link: move it away first` };
  }
  const existing = !!(await lstat(`${f.dir}/owner.json`));
  if (!existing) {
    let entries: string[] = [];
    try {
      entries = [...Deno.readDirSync(f.dir)].map((e) => e.name).filter((n) => !n.startsWith("."));
    } catch { /* a new folder */ }
    if (entries.length) {
      return { ok: false, message: `${shortHome(f.dir)} holds other files: choose an empty or a new folder` };
    }
  }
  // a link to another folder made by an earlier attempt: this answer replaces it
  const same = !!cur?.isSymlink && (await readlink(p.config)) === f.dir;
  if (cur?.isSymlink && !same) await Deno.remove(p.config);
  const owner = (await readRecord(p))?.owner;
  const args = [f.dir];
  if (owner && !existing) args.push("--name", owner.name, "--language", owner.language, "--id", idFrom(owner.name));
  const code = await init(args, p.config);
  if (code) return { ok: false, message: `agents init ${shortHome(f.dir)} ended with code ${code}` };
  // the same answer again keeps what the first one made
  if (!same) await updateRecord((r) => r.created = !existing, p);
  return { ok: true, existing };
}

/**
 * The profiles the page lists, written as manifests (`write`, the console's own): new ones made, a
 * changed command written with the rest of its manifest kept; one left as it was is not rewritten (a
 * configuration from another machine stays as it came). A declared profile left out is removed only
 * from a configuration the wizard made here, and only while it was never installed (no folder in the
 * runtime), as the example's `personal` may be: removing one from a synced configuration would remove
 * it from every machine.
 */
export async function setProfiles(
  b: { profiles?: unknown },
  write: (x: ProfileWrite) => Promise<{ error?: string }>,
  p = SETUP_PATHS,
  reserved: string[] = [],
): Promise<{ ok: boolean; message?: string }> {
  const c = checkProfiles(b.profiles as { name?: unknown; command?: unknown }[], reserved);
  if (!c.ok) return c;
  const before = await declared(p.config);
  const gone = before.filter((d) => !c.profiles.some((x) => x.name === d.profile));
  if (gone.length && !(await readRecord(p))?.created) {
    return {
      ok: false,
      message: `this configuration came from another machine: remove ${gone[0].profile} later, from System › Profiles`,
    };
  }
  for (const g of gone) {
    if (await lstat(`${p.runtime}/${g.profile}`)) {
      return { ok: false, message: `${g.profile} is installed already: remove it later from System › Profiles` };
    }
  }
  for (const x of c.profiles) {
    const was = before.find((d) => d.profile === x.name);
    if (was?.command === x.command) continue;
    const m = was ? await readJson<Manifest>(`${p.config}/profiles/${x.name}/profile.json`) : null;
    const r = await write({
      ...x,
      ...(m ? { description: m.description, alias: m.alias, desktopDir: m.desktopDir } : {}),
    });
    if (r.error) return { ok: false, message: r.error };
  }
  for (const g of gone) await Deno.remove(`${p.config}/profiles/${g.profile}`, { recursive: true });
  await updateRecord((r) => r.passed.push("profiles"), p);
  return { ok: true };
}

/** What the profiles step hands the manifest writer: the name and command, and for a profile that
 *  exists the fields the writer would otherwise drop. */
export interface ProfileWrite {
  name: string;
  command: string;
  description?: string;
  alias?: string;
  desktopDir?: string;
}

/** Records a step passed without a file of its own; `later` when it was put off. */
export async function passStep(b: { step?: unknown; later?: unknown }, p = SETUP_PATHS) {
  const step = String(b.step ?? "") as SetupStep;
  if (!PASSABLE.includes(step)) return { ok: false, message: `not a step to pass: ${step}` };
  await updateRecord((r) => {
    r.passed.push(step);
    if (b.later === true) r.later.push(step);
    else r.later = r.later.filter((s) => s !== step);
  }, p);
  return { ok: true };
}

/** The launcher of a declared, installed profile, to sign it in; null for anything else. */
export async function loginCommand(profile: unknown, p = SETUP_PATHS): Promise<string | null> {
  const f = (await declared(p.config)).find((d) => d.profile === profile);
  if (!f || !(await lstat(`${p.bin}/${f.command}`))) return null;
  return `${p.bin}/${f.command}`;
}

/**
 * Says once when `file` appears (a profile's credentials, written by Claude Code's sign-in in the
 * terminal the wizard opened), or gives up after `ms`. One watch per file: asking again while one
 * runs keeps that one.
 */
const watching = new Set<string>();
export function watchFor(file: string, then: () => void, ms = 15 * 60000) {
  if (watching.has(file)) return;
  const dir = file.slice(0, file.lastIndexOf("/"));
  let w: Deno.FsWatcher;
  try {
    w = Deno.watchFs(dir, { recursive: false });
  } catch {
    return;
  }
  watching.add(file);
  const stop = () => {
    watching.delete(file);
    clearTimeout(timer);
    try {
      w.close();
    } catch { /* closed */ }
  };
  const timer = setTimeout(stop, ms);
  void (async () => {
    try {
      for await (const e of w) {
        if (e.kind !== "access" && e.paths.includes(file) && await lstat(file)) {
          stop();
          then();
          return;
        }
      }
    } catch { /* closed */ }
  })();
}
