// backups.ts — the server's own copies: every database (accounts.db and each account's brain.db)
// sealed under BRAIN_BACKUP_KEY into BRAIN_DATA/backups/<UTC stamp>/, once a day, the last N kept.
//
// One folder per run (`2026-10-07T03-00-00`): accounts.db.brn and <account>.brn (an id has no dot, so
// the names cannot clash). The folder appears whole or not at all (written as .<stamp>.tmp, then
// renamed). The same functions serve the scheduled job in main.ts and `admin.ts backup|restore`.
// A copy is only as safe as the volume it sits on: it protects against a bad write or a lost
// account, not against losing the server; fetch it away (`GET /backup` is for that).

import { open, sealedCopy } from "./backup.ts";
import { tenantFile } from "./tenants.ts";
import { USER_ID } from "./users.ts";

const DAY = 86_400_000, HOUR = 3_600_000;
const STAMP = /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d$/;
const ACCOUNTS = "accounts.db.brn";

const root = (dataDir: string) => dataDir.replace(/\/+$/, "");
export const backupsDir = (dataDir: string) => `${root(dataDir)}/backups`;

/** Pure: the folder name of a run, UTC, so the names sort by time. */
export const stampOf = (d: Date) => d.toISOString().slice(0, 19).replace(/:/g, "-");

/** Pure: the runs to delete, oldest first, so that `keep` remain. */
export function toPrune(names: string[], keep: number): string[] {
  const own = names.filter((n) => STAMP.test(n)).sort();
  return own.slice(0, Math.max(0, own.length - keep));
}

async function dirs(path: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const e of Deno.readDir(path)) if (e.isDirectory) names.push(e.name);
  } catch { /* no such folder yet */ }
  return names;
}

/** When the newest run was made, or null. */
export async function latest(dataDir: string): Promise<Date | null> {
  const last = (await dirs(backupsDir(dataDir))).filter((n) => STAMP.test(n)).sort().pop();
  return last ? new Date(`${last.slice(0, 11)}${last.slice(11).replace(/-/g, ":")}Z`) : null;
}

/** Every database copied, sealed and kept; the oldest runs past `keep` removed. Returns the run's
 *  folder and the files in it. */
export async function backupAll(
  dataDir: string,
  key: string,
  keep: number,
  now = new Date(),
): Promise<{ dir: string; files: string[] }> {
  const base = backupsDir(dataDir), stamp = stampOf(now), tmp = `${base}/.${stamp}.tmp`, dir = `${base}/${stamp}`;
  await Deno.mkdir(base, { recursive: true });
  // what a run killed halfway left behind
  for (const n of await dirs(base)) if (/^\..*\.tmp$/.test(n)) await Deno.remove(`${base}/${n}`, { recursive: true });
  if (await Deno.stat(dir).catch(() => null)) throw new Error(`${stamp} already exists: one run a second at most`);
  await Deno.mkdir(tmp);
  const files: string[] = [];
  try {
    const dbs: [string, string][] = [[`${root(dataDir)}/accounts.db`, ACCOUNTS]];
    for (const id of (await dirs(`${root(dataDir)}/users`)).sort()) {
      if (USER_ID.test(id) && await Deno.stat(tenantFile(dataDir, id)).catch(() => null)) {
        dbs.push([tenantFile(dataDir, id), `${id}.brn`]);
      }
    }
    for (const [file, name] of dbs) {
      await Deno.writeFile(`${tmp}/${name}`, await sealedCopy(file, key, tmp), { mode: 0o600 });
      files.push(name);
    }
    await Deno.rename(tmp, dir);
  } catch (e) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    throw e;
  }
  for (const old of toPrune(await dirs(base), keep)) await Deno.remove(`${base}/${old}`, { recursive: true });
  return { dir, files };
}

/** The scheduled job: a run a day, the first thirty seconds after start when the last one is older
 *  than a day (otherwise when it turns a day old), an hour later after a failure. */
export function startBackups(dataDir: string, key: string, keep: number, log: (m: string) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> | null = null, stopped = false;
  const arm = (wait: number) => {
    if (!stopped) timer = setTimeout(() => void (running = run().finally(() => running = null)), wait);
  };
  const run = async () => {
    try {
      const r = await backupAll(dataDir, key, keep);
      log(`brain: backup ${r.dir} (${r.files.length} databases, keeping ${keep})`);
      arm(DAY);
    } catch (e) {
      log(`brain: backup failed: ${(e as Error).message}`);
      arm(HOUR);
    }
  };
  void latest(dataDir).then((last) => arm(Math.max(30_000, last ? last.getTime() + DAY - Date.now() : 0)));
  return {
    /** The timer cleared; a run in flight is waited for. */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}

/** The database a copy goes back to, by its name: accounts.db, or an account's brain.db. */
export function restoreTarget(dataDir: string, file: string): string {
  const name = file.split("/").pop() ?? "";
  if (name === ACCOUNTS) return `${root(dataDir)}/accounts.db`;
  const id = name.replace(/\.brn$/, "");
  if (!name.endsWith(".brn") || !USER_ID.test(id)) throw new Error(`${name} is not a copy made by this server`);
  return tenantFile(dataDir, id);
}

/** A copy opened with the key and put in place of its database, which stays beside it as
 *  `<name>.pre-restore` (its old WAL and shared-memory files dropped: they belong to it). The
 *  caller has made sure nothing holds the database. Returns the file written. */
export async function restoreCopy(dataDir: string, file: string, key: string): Promise<string> {
  const target = restoreTarget(dataDir, file);
  const plain = await open(await Deno.readFile(file) as Uint8Array<ArrayBuffer>, key);
  if (new TextDecoder().decode(plain.subarray(0, 15)) !== "SQLite format 3") throw new Error("not a database");
  await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
  const tmp = `${target}.restoring`;
  await Deno.writeFile(tmp, plain, { mode: 0o600 });
  if (await Deno.stat(target).catch(() => null)) await Deno.rename(target, `${target}.pre-restore`);
  for (const s of ["-wal", "-shm"]) await Deno.remove(`${target}${s}`).catch(() => {});
  await Deno.rename(tmp, target);
  return target;
}
