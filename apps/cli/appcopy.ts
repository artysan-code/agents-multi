// appcopy.ts — the app's code copied into the runtime (app mode, lib/mode.ts; docs/adr/0003).
//
// The package carries the code in its resources (`repo/`, scripts/bundle.sh), whose path is not
// stable — an AppImage mounts it somewhere new at every run, and a package update replaces it while
// Claude sessions read it — so the installation runs a copy of its own:
//
//   ~/.agents-multi/app/<version>-<digest>/   one build, in the repository's layout, with build.json
//   ~/.agents-multi/app/current  → <build>     the build in use: shared/, bin/ and the units go through it
//   ~/.agents-multi/app/previous → <build>     the one before, kept for a rollback; older ones go
//   ~/.agents-multi/bin/deno                   the package's Deno, which runs our MCP servers
//   ~/.agents-multi/bin/agents-multi-desktop   the app, which autostart and the launchers run
//
// A new build is copied beside the others and swapped in by renaming a link over `current`: a reader
// sees the old build or the new one, never half of one. Everything here takes its folders as
// arguments, so the tests run it on temporary ones.

import { listDir, lstat, readJson, readlink, stat } from "./lib/fs.ts";
import { run } from "./lib/proc.ts";
import { APP_DIR } from "./lib/mode.ts";

/** The stamp scripts/bundle.sh writes at the root of the package's code. */
export const BUILD_FILE = "build.json";
export interface Build {
  version: string;
  commit: string;
  /** sha-256 of the bundled files, so two builds of one version (a development build) differ */
  digest: string;
}

/** Pure: the folder name of a build: its version and the start of its digest. */
export const buildId = (b: Build) => `${b.version}-${b.digest.slice(0, 12)}`;

/** The build stamp of a folder of code, or null when it has none (a checkout, or not code at all). */
export async function readBuild(dir: string): Promise<Build | null> {
  const b = await readJson<Partial<Build>>(`${dir}/${BUILD_FILE}`);
  return b && typeof b.version === "string" && typeof b.digest === "string" && b.digest.length >= 12
    ? { version: b.version, commit: String(b.commit ?? ""), digest: b.digest }
    : null;
}

export interface CopyResult {
  /** whether `current` moved */
  changed: boolean;
  /** the build in use before, if any */
  from: string | null;
  to: string;
}

/** Replaces `link` with a symlink to `target`, by renaming a new link over it. */
async function swapLink(link: string, target: string) {
  const tmp = `${link}.tmp-${Deno.pid}`;
  await Deno.remove(tmp).catch(() => {});
  await Deno.symlink(target, tmp);
  await Deno.rename(tmp, link);
}

/**
 * Installs the code in `src` (the package's, with its build.json) as `<root>/app/<build>` and makes
 * it current, the build in use before becoming `previous`. Idempotent: the build already current is
 * left alone. Links to skills installed by other tools (absolute links in shared/skills, `install`
 * makes them) are carried over from the build in use, so they do not disappear until the next install.
 */
export async function installCopy(
  src: string,
  root: string,
  o: { dry?: boolean; log?: (s: string) => void } = {},
): Promise<CopyResult> {
  const log = o.log ?? (() => {});
  const build = await readBuild(src);
  if (!build) throw new Error(`${src} carries no ${BUILD_FILE}: it is not the app's code`);
  const id = buildId(build);
  const app = `${root}/${APP_DIR}`;
  const from = await readlink(`${app}/current`);
  const ready = (await readBuild(`${app}/${id}`))?.digest === build.digest;
  if (from === id && ready) return { changed: false, from, to: id };
  log(`${o.dry ? "(dry) " : ""}the app's code ${build.version} (${id}) → ${app}/${id}${from ? `, was ${from}` : ""}`);
  if (o.dry) return { changed: true, from, to: id };
  await Deno.mkdir(app, { recursive: true });
  if (!ready) {
    const tmp = `${app}/.${id}.tmp-${Deno.pid}`;
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    await Deno.remove(`${app}/${id}`, { recursive: true }).catch(() => {});
    await Deno.mkdir(tmp, { recursive: true });
    const cp = await run("cp", ["-a", `${src}/.`, tmp]);
    if (cp.code !== 0) {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
      throw new Error(`copying ${src}: ${cp.err}`);
    }
    // the code runs as this user: nobody else writes it, whatever modes the package carried (the
    // AppImage built in CI brings its files writable by all)
    const ch = await run("chmod", ["-R", "go-w", tmp]);
    if (ch.code !== 0) {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
      throw new Error(`securing ${tmp}: ${ch.err}`);
    }
    if (from) await carrySkillLinks(`${app}/${from}/shared/skills`, `${tmp}/shared/skills`);
    await Deno.rename(tmp, `${app}/${id}`);
  }
  if (from && from !== id && (await stat(`${app}/${from}`))) await swapLink(`${app}/previous`, from);
  await swapLink(`${app}/current`, id);
  await prune(app);
  return { changed: true, from, to: id };
}

/** Absolute links in the old build's shared/skills that the new one lacks. */
async function carrySkillLinks(old: string, next: string) {
  await Deno.mkdir(next, { recursive: true });
  for (const n of await listDir(old)) {
    const target = await readlink(`${old}/${n}`);
    if (target?.startsWith("/") && !(await lstat(`${next}/${n}`))) await Deno.symlink(target, `${next}/${n}`);
  }
}

/** Removes the builds that are neither current nor previous, and leftovers of an interrupted copy. */
async function prune(app: string) {
  const keep = new Set([await readlink(`${app}/current`), await readlink(`${app}/previous`), "current", "previous"]);
  for (const n of await listDir(app)) {
    if (keep.has(n)) continue;
    // another install's copy in progress has its pid in the name; a dead one's is left over
    const pid = n.match(/\.tmp-(\d+)$/)?.[1];
    if (pid && pid !== String(Deno.pid) && (await stat(`/proc/${pid}`))) continue;
    await Deno.remove(`${app}/${n}`, { recursive: true }).catch(() => {});
  }
}

/** Pure: how a program of the package reaches the runtime's bin/: a link where the package's path
 *  outlives the run (a deb, an rpm, a folder), a copy out of an AppImage, whose mount goes with it. */
export const keepBy = (appimage: boolean): "link" | "copy" => appimage ? "copy" : "link";

/**
 * `<root>/bin/<name>` for the package's program at `from`: a link to it, or a copy (`keepBy`). Says
 * whether it changed.
 */
export async function keepProgram(from: string, root: string, name: string, appimage: boolean): Promise<boolean> {
  const dest = `${root}/bin/${name}`;
  await Deno.mkdir(`${root}/bin`, { recursive: true });
  if (keepBy(appimage) === "link") {
    if ((await readlink(dest)) === from) return false;
    await swapLink(dest, from);
    return true;
  }
  const [a, b] = [await stat(from), await lstat(dest)];
  if (b?.isFile && a?.size === b.size && a.mtime?.getTime() === b.mtime?.getTime()) return false;
  const tmp = `${dest}.tmp-${Deno.pid}`;
  const cp = await run("cp", ["--preserve=mode,timestamps", from, tmp]);
  if (cp.code !== 0) throw new Error(`copying ${from}: ${cp.err}`);
  await Deno.rename(tmp, dest);
  return true;
}

/**
 * Copies into the person's Deno cache (`to`) the files of the package's (`from`) it does not have:
 * the modules our MCP servers import, so they start on the first run without the network. Files that
 * exist are left as they are. Returns how many it copied.
 */
export async function seedCache(from: string, to: string): Promise<number> {
  if (!(await stat(from))?.isDirectory) return 0;
  let n = 0;
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(`${from}${rel}`)) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory) await walk(r);
      else if (e.isFile && !(await lstat(`${to}${r}`))) {
        await Deno.mkdir(`${to}${rel}`, { recursive: true });
        await Deno.copyFile(`${from}${r}`, `${to}${r}`);
        n++;
      }
    }
  };
  await walk("");
  return n;
}
