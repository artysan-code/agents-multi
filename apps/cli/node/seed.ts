// seed.ts — `agents node seed <machine>` (ADR 0014, slice A): the files a clone lacks because git ignores them
// (`.env`, `.env.*`, `.dev.vars`, `.dev.vars.*`) go through the vault, sealed, to a machine that will have the
// repository. Collected on a machine with the vault (the owner's PC), one vault entry per repository (service
// `seed`, account `<host>/<path>`); written by the node when it clones or updates that repository, only if the
// entry names it, only where git ignores the file in that clone, never over a file that differs. A client's
// repository only with an explicit `--repo`. Values are never printed nor logged: paths and sizes only.

import { normalRemote } from "../../../shared/mcp/lib/nodes.ts";
import { loadNodeConfig, type NodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { remoteOf } from "../../../shared/mcp/lib/moving.ts";
import { deleteSecret, getSecret, listSecrets, loadKey, setSecret, vaultDir } from "../../../shared/mcp/lib/vault.ts";
import { writeAtomic } from "../lib/fs.ts";
import { ANSI } from "../lib/output.ts";
import { HOME, shortHome, STATE } from "../lib/paths.ts";
import { remoteAllowed } from "./clone.ts";
import { nodeName } from "./facts.ts";
import { fleet, service } from "./service.ts";

/** Where an entry is kept in the vault: service `seed`, account the repository's `host/path`. */
export const SEED = { service: "seed", field: "files" } as const;

/** One over is skipped with its name, never truncated. */
export const SEED_CAP = { file: 64 * 1024, files: 20, repo: 256 * 1024, entries: 200 } as const;

/** A client's entry older than this is the doctor's to raise: re-seed it or forget it. */
export const CLIENT_DAYS = 90;

export interface SeedFile {
  /** relative to the repository's root */
  path: string;
  mode: number;
  b64: string;
}

export interface SeedEntry {
  v: 1;
  at: string;
  /** the machine that seeded it */
  from: string;
  /** the machines that write it */
  nodes: string[];
  client?: true;
  files: SeedFile[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const NEVER_DIRS = new Set(["node_modules", ".git", "vendor", "dist", ".claude", ".agents"]);
const NEVER_NAMES = [/\.pem$/i, /\.key$/i, /^id_/, /^\.npmrc$/, /^\.netrc$/, /^credentials/i, /\.p12$/i, /\.kdbx$/i];

/** Pure: whether a file's name is one seeded: `.env`, `.env.*`, `.dev.vars`, `.dev.vars.*`. */
export const seedName = (base: string) =>
  base === ".env" || base.startsWith(".env.") || base === ".dev.vars" || base.startsWith(".dev.vars.");

/** Pure: why a path (relative to its repository) is never seeded, or null when its name and place allow it: at
 *  the root or at most three folders down, never under node_modules/.git/vendor/dist/.claude/.agents, never a key
 *  or a credentials file whatever it is called. */
export function seedRefusal(path: string): string | null {
  const parts = path.split("/");
  if (!path || path.startsWith("/") || parts.some((p) => p === "" || p === "." || p === "..")) {
    return "not a path in it";
  }
  const base = parts[parts.length - 1];
  if (!seedName(base)) return "not an env file";
  if (parts.length > 4) return "more than three folders down";
  const dir = parts.slice(0, -1).find((p) => NEVER_DIRS.has(p));
  if (dir) return `under ${dir}/`;
  if (NEVER_NAMES.some((r) => r.test(base))) return "a key or credentials file";
  return null;
}

/** Pure: a file's bytes as UTF-8 text, or null when they are not (binary, a NUL in them). */
export function textOf(bytes: Uint8Array): string | null {
  try {
    const t = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return t.includes("\0") ? null : t;
  } catch {
    return null;
  }
}

/** Pure: a Claude or Anthropic credential in a text: such a file is never seeded. */
export const hasClaudeKey = (text: string) => /sk-ant-[\w-]{8,}/.test(text);

/** Pure: the files kept under the caps (64 KiB each, 20 and 256 KiB a repository), in path order; the rest skipped
 *  with why, never cut. */
export function capFiles<T extends { path: string; size: number }>(
  files: T[],
): { kept: T[]; skipped: { path: string; why: string }[] } {
  const kept: T[] = [], skipped: { path: string; why: string }[] = [];
  let total = 0;
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (f.size > SEED_CAP.file) skipped.push({ path: f.path, why: `over ${SEED_CAP.file / 1024} KiB` });
    else if (kept.length >= SEED_CAP.files) skipped.push({ path: f.path, why: `over ${SEED_CAP.files} files` });
    else if (total + f.size > SEED_CAP.repo) skipped.push({ path: f.path, why: `over ${SEED_CAP.repo / 1024} KiB` });
    else (kept.push(f), total += f.size);
  }
  return { kept, skipped };
}

/** Pure: the entry a seed writes. The machines of an earlier entry stay (seeding a second machine does not take the
 *  files from the first); its files are replaced. */
export function seedEntry(
  o: { at: string; from: string; machine: string; client: boolean; files: SeedFile[] },
  prev: SeedEntry | null,
): SeedEntry {
  const nodes = [...new Set([...(prev?.nodes ?? []), o.machine])].sort();
  return { v: 1, at: o.at, from: o.from, nodes, ...(o.client ? { client: true as const } : {}), files: o.files };
}

/** Pure: an entry read from the vault, kept to what is valid; null when it is not one. */
export function parseSeedEntry(raw: unknown): SeedEntry | null {
  let r = raw;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  const e = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
  if (e.v !== 1 || typeof e.at !== "string" || !Array.isArray(e.nodes) || !Array.isArray(e.files)) return null;
  const files = (e.files as unknown[]).flatMap((f) => {
    const x = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    return typeof x.path === "string" && typeof x.b64 === "string" && !seedRefusal(x.path)
      ? [{ path: x.path, mode: typeof x.mode === "number" ? x.mode & 0o777 : 0o600, b64: x.b64 }]
      : [];
  });
  return {
    v: 1,
    at: e.at,
    from: typeof e.from === "string" ? e.from : "",
    nodes: (e.nodes as unknown[]).filter((n): n is string => typeof n === "string" && NAME.test(n)),
    ...(e.client === true ? { client: true as const } : {}),
    files,
  };
}

/** Pure: the files a machine writes from an entry: none when the entry does not name it. */
export const filesFor = (e: SeedEntry, self: string): SeedFile[] => e.nodes.includes(self) ? e.files : [];

export interface Finding {
  status: "ok" | "warn";
  msg: string;
}

/** Pure: what the doctor says of the vault's seeds: an entry naming a machine the service does not know (`known`
 *  null: the service was not reached, so that is not checked), a client's older than 90 days, too many entries. */
export function seedFindings(
  entries: { account: string; entry: SeedEntry }[],
  known: string[] | null,
  now: number,
): Finding[] {
  const out: Finding[] = [];
  for (const { account, entry } of entries) {
    const unknown = known ? entry.nodes.filter((n) => !known.includes(n)) : [];
    if (unknown.length) {
      out.push({ status: "warn", msg: `seed of ${account} names ${unknown.join(", ")}, unknown to the service` });
    }
    const days = (now - Date.parse(entry.at)) / 86_400_000;
    if (entry.client && days > CLIENT_DAYS) {
      out.push({ status: "warn", msg: `seed of ${account} is a client's, ${Math.floor(days)} days old` });
    }
  }
  if (entries.length > SEED_CAP.entries) {
    out.push({ status: "warn", msg: `${entries.length} seeded repositories, over ${SEED_CAP.entries}` });
  }
  if (!out.length && entries.length) out.push({ status: "ok", msg: `${entries.length} seeded repositories` });
  return out;
}

// ---------------------------------------------------------------- collecting, on the machine with the vault

async function git(dir: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  })
    .output().catch(() => null);
  return { ok: !!r?.success, out: r ? new TextDecoder().decode(r.stdout) : "" };
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(`${dir.replace(/\/+$/, "")}/`);

/** The env files of one repository that may be seeded, under the caps, and the ones skipped with why. */
export async function collectSeed(
  repo: string,
  o: { never?: string[] } = {},
): Promise<{ files: (SeedFile & { size: number })[]; skipped: { path: string; why: string }[] }> {
  const root = await Deno.realPath(repo);
  const never = (o.never ?? [vaultDir(), STATE]).map((p) => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p;
    }
  });
  const ls = await git(root, [
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ":(glob)**/.env",
    ":(glob)**/.env.*",
    ":(glob)**/.dev.vars",
    ":(glob)**/.dev.vars.*",
  ]);
  const skipped: { path: string; why: string }[] = [];
  const found: (SeedFile & { size: number })[] = [];
  for (const path of ls.out.split("\0").filter(Boolean)) {
    const no = seedRefusal(path);
    if (no) {
      if (no !== "not an env file") skipped.push({ path, why: no });
      continue;
    }
    const full = `${root}/${path}`;
    const st = await Deno.lstat(full).catch(() => null);
    if (!st?.isFile) {
      skipped.push({ path, why: st?.isSymlink ? "a symlink" : "not a file" });
      continue;
    }
    const real = await Deno.realPath(full).catch(() => "");
    if (!inside(real, root) || never.some((n) => inside(real, n))) {
      skipped.push({ path, why: "outside the repository" });
      continue;
    }
    if (st.size > SEED_CAP.file) {
      found.push({ path, mode: (st.mode ?? 0o600) & 0o777, b64: "", size: st.size });
      continue;
    }
    const bytes = await Deno.readFile(full);
    const text = textOf(bytes);
    if (text === null) {
      skipped.push({ path, why: "not UTF-8 text" });
      continue;
    }
    if (hasClaudeKey(text)) {
      skipped.push({ path, why: "holds a Claude/Anthropic key (sk-ant-…)" });
      continue;
    }
    found.push({ path, mode: (st.mode ?? 0o600) & 0o777, b64: b64(bytes), size: bytes.length });
  }
  const { kept, skipped: over } = capFiles(found);
  return { files: kept, skipped: [...skipped, ...over] };
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** The main checkouts under `roots`, a few folders deep, with their remote (normalised); none without one. */
export async function listClones(roots: string[], home: string, depth = 3): Promise<{ dir: string; repo: string }[]> {
  const out: { dir: string; repo: string }[] = [];
  const walk = async (dir: string, left: number) => {
    const st = await Deno.lstat(`${dir}/.git`).catch(() => null);
    if (st?.isDirectory) {
      const repo = await remoteOf(dir);
      if (repo) out.push({ dir, repo });
      return;
    }
    if (left === 0) return;
    const subs: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isDirectory && !e.name.startsWith(".") && e.name !== "node_modules" && !e.name.endsWith("-wt")) {
          subs.push(`${dir}/${e.name}`);
        }
      }
    } catch { /* unreadable */ }
    for (const s of subs.sort()) await walk(s, left - 1);
  };
  for (const r of roots) await walk(r.replace(/^~(?=\/|$)/, home), depth);
  return out;
}

// ---------------------------------------------------------------- writing, on the node

/** What was reported already, so a file that differs is said once per process, not at each job. */
const reported = new Set<string>();

/** Writes an entry's files into a clone: 0600, atomically, only where git ignores the path in that clone and its
 *  folder is in it, never over a file that exists and differs (kept, said once). */
export async function applySeedFiles(
  dir: string,
  files: SeedFile[],
  log: (s: string) => void = () => {},
): Promise<{ written: string[]; same: string[]; kept: string[]; skipped: { path: string; why: string }[] }> {
  const out = {
    written: [] as string[],
    same: [] as string[],
    kept: [] as string[],
    skipped: [] as { path: string; why: string }[],
  };
  const root = await Deno.realPath(dir);
  for (const f of files) {
    const no = seedRefusal(f.path);
    if (no) {
      out.skipped.push({ path: f.path, why: no });
      continue;
    }
    const dest = `${root}/${f.path}`;
    const parent = await Deno.realPath(dest.slice(0, dest.lastIndexOf("/"))).catch(() => "");
    if (!parent || !inside(parent, root)) {
      out.skipped.push({ path: f.path, why: "its folder is not in this clone" });
      continue;
    }
    const ignored = await new Deno.Command("git", {
      args: ["-C", root, "check-ignore", "-q", "--", f.path],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output().then((r) => r.code === 0, () => false);
    if (!ignored) {
      out.skipped.push({ path: f.path, why: "git does not ignore it in this clone" });
      continue;
    }
    const bytes = unb64(f.b64);
    const st = await Deno.lstat(dest).catch(() => null);
    if (st) {
      const now = st.isFile ? await Deno.readFile(dest).catch(() => null) : null;
      if (now && now.length === bytes.length && now.every((b, i) => b === bytes[i])) out.same.push(f.path);
      else {
        out.kept.push(f.path);
        const k = `${root}\0${f.path}`;
        if (!reported.has(k)) {
          reported.add(k);
          log(`node: ${shortHome(dest)} differs from its seed: kept as it is`);
        }
      }
      continue;
    }
    await writeAtomic(dest, bytes, { mode: 0o600 });
    out.written.push(f.path);
  }
  return out;
}

/** The node's side, after a clone is found or made: the entry of `repo` from the vault, when this machine opens it
 *  and the entry names this machine. No vault here, or no entry: nothing to write. */
export async function applySeeded(cfg: NodeConfig, dir: string, repo: string, log: (s: string) => void) {
  const raw = await getSecret(SEED.service, normalRemote(repo), SEED.field).catch(() => null);
  const entry = raw ? parseSeedEntry(raw) : null;
  if (!entry) return;
  const files = filesFor(entry, nodeName(cfg));
  if (!files.length) return;
  const r = await applySeedFiles(dir, files, log);
  if (r.written.length) log(`node: ${repo}: ${r.written.join(", ")} written from its seed`);
  for (const s of r.skipped) log(`node: ${repo}: ${s.path} not written: ${s.why}`);
}

// ---------------------------------------------------------------- the command

/** Pure: `agents node seed`'s arguments. */
export function parseSeedArgs(
  args: string[],
): { machine?: string; repos: string[]; dryRun: boolean; forget?: string } | { error: string } {
  const repos: string[] = [];
  let machine: string | undefined, forget: string | undefined, dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--repo" || a === "--forget") {
      const v = args[++i];
      if (!v) return { error: `${a} needs a value` };
      if (a === "--repo") repos.push(v);
      else forget = v;
    } else if (a.startsWith("-")) return { error: `unknown option ${a}` };
    else if (machine) return { error: `one machine at a time (${machine}, ${a})` };
    else machine = a;
  }
  if (forget) {
    return machine || repos.length ? { error: "--forget takes only the repository" } : { repos, dryRun, forget };
  }
  if (!machine) return { error: "which machine?" };
  if (!NAME.test(machine)) return { error: `not a machine's name: ${machine}` };
  return { machine, repos, dryRun };
}

export const SEED_USAGE =
  "usage: agents node seed <machine> [--repo <path>]... [--dry-run] | agents node seed --forget <repo>";

async function ask(prompt: string): Promise<string> {
  await Deno.stdout.write(new TextEncoder().encode(prompt));
  const buf = new Uint8Array(256);
  const n = await Deno.stdin.read(buf);
  return new TextDecoder().decode(buf.subarray(0, n ?? 0)).trim();
}

/** The account of a repository given as a folder (its `origin`) or as a remote. */
async function accountOf(arg: string): Promise<string | null> {
  const p = arg.replace(/^~(?=\/|$)/, HOME);
  const st = await Deno.stat(p).catch(() => null);
  if (st?.isDirectory) return await remoteOf(p);
  return /[/:]/.test(arg) ? normalRemote(arg) : null;
}

export async function seedCommand(args: string[]): Promise<number> {
  const a = parseSeedArgs(args);
  if ("error" in a) {
    console.error(`${a.error}\n${SEED_USAGE}`);
    return 2;
  }
  if (a.forget) {
    const account = await accountOf(a.forget);
    if (!account) return (console.error(`${a.forget}: no repository with an origin, nor a remote`), 1);
    const gone = await deleteSecret(SEED.service, account, SEED.field);
    console.log(gone ? `forgotten: the seed of ${account}` : `no seed of ${account} in the vault`);
    return 0;
  }
  const machine = a.machine!;
  const cfg = await loadNodeConfig();

  // the machine: one the service knows, when it answers (a typo would seed nobody)
  const svc = await service().catch(() => null);
  const known = svc && typeof svc !== "string"
    ? await fleet(svc).then((f) => f.nodes.map((n) => n.name), () => null)
    : null;
  if (known && !known.includes(machine)) {
    console.error(`the service knows no machine ${machine} (${known.join(", ") || "none"}): agents nodes`);
    return 1;
  }
  if (!known) console.log(`${ANSI.y}!${ANSI.x} the service did not answer: ${machine} is taken as written`);

  // the owner's repositories under this machine's roots, and each explicit --repo (a client's when not allowed)
  const chosen: { dir: string; repo: string; client: boolean }[] = (await listClones(cfg.repoRoots, HOME))
    .filter((c) => remoteAllowed(cfg, c.repo).ok)
    .map((c) => ({ ...c, client: false }));
  for (const r of a.repos) {
    const dir = r.replace(/^~(?=\/|$)/, HOME);
    const repo = (await Deno.stat(`${dir}/.git`).catch(() => null)) ? await remoteOf(dir) : null;
    if (!repo) return (console.error(`${r}: not a repository with an origin`), 1);
    const client = !remoteAllowed(cfg, repo).ok;
    const i = chosen.findIndex((c) => c.repo === repo);
    if (i >= 0) chosen.splice(i, 1);
    chosen.push({ dir, repo, client });
  }
  if (!chosen.length) {
    console.log(
      "no repository to seed: none under repoRoots is in repos or gitHosts (config/nodes.json); --repo <path>",
    );
    return 0;
  }

  const key = a.dryRun ? null : await loadKey();
  const existing = key ? (await listSecrets(key)).entries.filter((e) => e.service === SEED.service) : [];
  let count = existing.length, failed = 0;
  for (const c of chosen) {
    const { files, skipped } = await collectSeed(c.dir);
    console.log(`${ANSI.b}${c.repo}${ANSI.x} (${shortHome(c.dir)})${c.client ? `, ${ANSI.y}a client's${ANSI.x}` : ""}`);
    for (const f of files) console.log(`  ${f.path} (${f.size} bytes)`);
    for (const s of skipped) console.log(`  ${ANSI.y}skipped${ANSI.x} ${s.path}: ${s.why}`);
    if (!files.length) {
      console.log("  nothing to seed");
      continue;
    }
    if (a.dryRun) continue;
    if (c.client) {
      if (!Deno.stdin.isTerminal()) {
        console.error(`  a client's repository: seed it from a terminal, where you can say yes`);
        failed++;
        continue;
      }
      const yes = (await ask(
        `  ${c.repo} is not yours (not in repos or gitHosts): its env files go to ${machine}, in the vault. Seed it? [y/N] `,
      )).toLowerCase();
      if (yes !== "y" && yes !== "yes") {
        console.log("  not seeded");
        continue;
      }
    }
    const prev = parseSeedEntry(await getSecret(SEED.service, c.repo, SEED.field, key!));
    if (!prev && count >= SEED_CAP.entries) {
      console.error(`  not seeded: the vault holds ${SEED_CAP.entries} seeds already (--forget one)`);
      failed++;
      continue;
    }
    const entry = seedEntry({
      at: new Date().toISOString(),
      from: nodeName(cfg),
      machine,
      client: c.client,
      files: files.map(({ path, mode, b64 }) => ({ path, mode, b64 })),
    }, prev);
    await setSecret(SEED.service, c.repo, JSON.stringify(entry), SEED.field, key!);
    if (!prev) count++;
    console.log(`  ${ANSI.g}✓${ANSI.x} sealed in the vault for ${entry.nodes.join(", ")}`);
  }
  return failed ? 1 : 0;
}
