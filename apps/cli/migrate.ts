// migrate.ts — `agents migrate [--dry-run] [--rollback] [--force]`: the runtime moves from
// ~/.claude-multi to ~/.agents-multi.
//
// The folder is renamed (one rename on the same filesystem: sessions, plugins and logins move with
// it) and the old name becomes a link to the new one, so whatever still names it — a person's
// CLAUDE.md imports, transcripts, an old backup — keeps resolving. The few files Claude Code keeps
// absolute paths in (each profile's .claude.json and its plugin records) are rewritten to the new
// name, a copy of each kept first. --rollback does the reverse and leaves ~/.agents-multi a link to
// the old folder, the state every machine is in before it moves (runtime-root.ts).
//
// Claude must be closed: a session holds its config directory by path, and a file it rewrites
// while we do would undo the rewrite. Running instances refuse the move unless --force.

import { ANSI } from "./lib/output.ts";
import { LEGACY_RUNTIME_NAME, RUNTIME_NAME } from "./lib/runtime-root.ts";

/** Files under a profile that hold absolute paths into the runtime. */
const PATH_FILES = [".claude.json", "plugins/installed_plugins.json", "plugins/known_marketplaces.json"];

interface MigrateOptions {
  home: string;
  dry: boolean;
  rollback: boolean;
  /** where the copies of the rewritten files go */
  backupDir: string;
  /** the Claude instances running now, by name; refused unless `force` */
  running: string[];
  force?: boolean;
  log?: (line: string) => void;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pure: `text` with every absolute path into `${home}/<from>` turned to `${home}/<to>`. Only the
 *  folder itself and what is under it: ~/.claude-multi-config or ~/.claude-multi.bak are not it. */
export function rewritePaths(text: string, home: string, from: string, to: string): string {
  return text.replace(new RegExp(`${escape(`${home}/${from}`)}(?=[/"'\\s]|$)`, "g"), `${home}/${to}`);
}

async function lstat(p: string) {
  return await Deno.lstat(p).catch(() => null);
}
async function readLink(p: string) {
  return await Deno.readLink(p).catch(() => null);
}

/** Rewrites PATH_FILES of every profile under `root`, copying each changed one into `backupDir`
 *  first. Returns the files (relative to `root`) that changed — or would, when `dry`. */
async function rewriteAll(root: string, o: MigrateOptions, from: string, to: string): Promise<string[]> {
  const changed: string[] = [];
  const dirs: string[] = [];
  for await (const e of Deno.readDir(root)) if (e.isDirectory) dirs.push(e.name);
  for (const d of dirs.sort()) {
    for (const f of PATH_FILES) {
      const rel = `${d}/${f}`;
      const path = `${root}/${rel}`;
      const st = await lstat(path);
      if (!st?.isFile) continue;
      const text = await Deno.readTextFile(path);
      const next = rewritePaths(text, o.home, from, to);
      if (next === text) continue;
      changed.push(rel);
      if (o.dry) continue;
      const copy = `${o.backupDir}/${rel}`;
      await Deno.mkdir(copy.slice(0, copy.lastIndexOf("/")), { recursive: true, mode: 0o700 });
      await Deno.copyFile(path, copy);
      await Deno.chmod(copy, 0o600);
      // written beside and renamed over: a crash leaves the old file or the new, never half of one
      const tmp = `${path}.agents-migrate.tmp`;
      await Deno.writeTextFile(tmp, next, { mode: (st.mode ?? 0o600) & 0o777 });
      await Deno.chmod(tmp, (st.mode ?? 0o600) & 0o777);
      await Deno.rename(tmp, path);
    }
  }
  return changed;
}

export async function migrate(o: MigrateOptions): Promise<number> {
  const log = o.log ?? console.log;
  const now = `${o.home}/${RUNTIME_NAME}`;
  const old = `${o.home}/${LEGACY_RUNTIME_NAME}`;
  const [nowSt, oldSt] = [await lstat(now), await lstat(old)];
  const nowIsDir = !!nowSt?.isDirectory && !nowSt.isSymlink;
  const oldIsDir = !!oldSt?.isDirectory && !oldSt.isSymlink;
  const pointsAt = async (link: string, name: string, st: Deno.FileInfo | null) =>
    !!st?.isSymlink && [name, `${o.home}/${name}`].includes(await readLink(link) ?? "");
  const pre = o.dry ? `${ANSI.d}(dry-run)${ANSI.x} ` : "";
  const fail = (msg: string) => (log(`  ${ANSI.r}✗${ANSI.x} ${msg}`), 1);

  // where things stand: moved, not moved, or something this command did not make
  const moved = nowIsDir && (!oldSt || await pointsAt(old, RUNTIME_NAME, oldSt));
  const notMoved = oldIsDir && (!nowSt || await pointsAt(now, LEGACY_RUNTIME_NAME, nowSt));
  if (!moved && !notMoved) {
    if (nowIsDir && oldIsDir) {
      return fail(`both ~/${RUNTIME_NAME} and ~/${LEGACY_RUNTIME_NAME} are folders: merge them by hand`);
    }
    if (!nowSt && !oldSt) {
      return fail(`no runtime at ~/${RUNTIME_NAME} or ~/${LEGACY_RUNTIME_NAME}: run agents install`);
    }
    return fail(`~/${RUNTIME_NAME} and ~/${LEGACY_RUNTIME_NAME} are not what this command makes: look at them by hand`);
  }
  if (moved && !o.rollback) {
    // already moved: the rewrite is idempotent, so it runs again for what a rollback-then-update left
    const files = await rewriteAll(now, o, LEGACY_RUNTIME_NAME, RUNTIME_NAME);
    log(
      `  ${ANSI.g}✓${ANSI.x} the runtime is already ~/${RUNTIME_NAME}${
        files.length ? `; ${pre}rewrote ${files.join(", ")}` : ""
      }`,
    );
    return 0;
  }
  if (o.rollback && notMoved) {
    log(`  ${ANSI.g}✓${ANSI.x} the runtime is already ~/${LEGACY_RUNTIME_NAME}: nothing to roll back`);
    return 0;
  }
  if (o.running.length && !o.force) {
    if (o.dry) {
      log(
        `  ${ANSI.y}!${ANSI.x} Claude is running (${
          o.running.join(", ")
        }): the real run will refuse until it is closed`,
      );
    } else {return fail(
        `Claude is running (${o.running.join(", ")}): close it and run this from a terminal, or pass --force`,
      );}
  }

  let files: string[];
  if (!o.rollback) {
    log(`  ${pre}~/${LEGACY_RUNTIME_NAME} → ~/${RUNTIME_NAME}, and ~/${LEGACY_RUNTIME_NAME} a link to it`);
    if (!o.dry) {
      if (nowSt) await Deno.remove(now);
      await Deno.rename(old, now);
      await Deno.symlink(RUNTIME_NAME, old);
    }
    files = await rewriteAll(o.dry ? old : now, o, LEGACY_RUNTIME_NAME, RUNTIME_NAME);
  } else {
    // paths first: they resolve under either name until the folder moves
    files = await rewriteAll(now, o, RUNTIME_NAME, LEGACY_RUNTIME_NAME);
    log(`  ${pre}~/${RUNTIME_NAME} → ~/${LEGACY_RUNTIME_NAME}, and ~/${RUNTIME_NAME} a link to it`);
    if (!o.dry) {
      if (oldSt) await Deno.remove(old);
      await Deno.rename(now, old);
      await Deno.symlink(LEGACY_RUNTIME_NAME, now);
    }
  }
  log(`  ${pre}paths rewritten in ${files.length ? files.join(", ") : "no file"}`);
  if (files.length && !o.dry) log(`  copies of the files as they were in ${o.backupDir}`);
  return 0;
}
