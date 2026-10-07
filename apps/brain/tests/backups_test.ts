// Tests for the server's own copies (backups.ts): a run seals every database, rotation keeps the
// last N, and a copy goes back in place only with its key.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { open } from "../backup.ts";
import { backupAll, latest, restoreCopy, restoreTarget, stampOf, toPrune } from "../backups.ts";
import { Store } from "../store.ts";
import { tenantFile } from "../tenants.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));

/** A data dir with an accounts.db and the brains of alice and bob. */
function dataDir(): string {
  const d = Deno.makeTempDirSync();
  const a = new DatabaseSync(`${d}/accounts.db`);
  a.exec("pragma journal_mode = wal; create table users (id text)");
  a.exec("insert into users values ('alice')");
  a.close();
  for (const id of ["alice", "bob"]) {
    Deno.mkdirSync(`${d}/users/${id}`, { recursive: true });
    const s = new Store(tenantFile(d, id));
    s.write("note.md", `# ${id}`, "test");
    s.close();
  }
  return d;
}
const at = (n: number) => new Date(Date.UTC(2026, 9, 7, 3, 0, n));

Deno.test("backups: names sort by time, and only runs are pruned, oldest first", () => {
  assertEquals(stampOf(at(5)), "2026-10-07T03-00-05");
  const names = [
    "2026-10-01T03-00-00",
    "2026-10-03T03-00-00",
    "2026-10-02T03-00-00",
    "notes",
    ".2026-10-04T03-00-00.tmp",
  ];
  assertEquals(toPrune(names, 2), ["2026-10-01T03-00-00"]);
  assertEquals(toPrune(names, 5), []);
});

Deno.test("backups: a run seals accounts.db and each brain, and keeps the last N", async () => {
  const d = dataDir();
  assertEquals(await latest(d), null);
  const first = await backupAll(d, KEY, 2, at(1));
  assertEquals(first.files, ["accounts.db.brn", "alice.brn", "bob.brn"]);
  const sealed = await Deno.readFile(`${first.dir}/alice.brn`);
  assertEquals(new TextDecoder().decode(sealed.subarray(0, 4)), "BRN1");
  assertEquals(new TextDecoder().decode((await open(sealed, KEY)).subarray(0, 15)), "SQLite format 3");
  await assertRejects(() => open(sealed, btoa(String.fromCharCode(...new Uint8Array(32).fill(4)))));

  await backupAll(d, KEY, 2, at(2));
  await backupAll(d, KEY, 2, at(3));
  const left = [...Deno.readDirSync(`${d}/backups`)].map((e) => e.name).sort();
  assertEquals(left, [stampOf(at(2)), stampOf(at(3))]);
  assertEquals(await latest(d), at(3));
  await assertRejects(() => backupAll(d, KEY, 2, at(3)), Error, "already exists");
  assertEquals([...Deno.readDirSync(`${d}/backups`)].length, 2); // the refusal left nothing behind
});

Deno.test("backups: a stale half-written run is cleaned up by the next one", async () => {
  const d = dataDir();
  Deno.mkdirSync(`${d}/backups/.2026-10-01T03-00-00.tmp`, { recursive: true });
  await backupAll(d, KEY, 7, at(1));
  assertEquals([...Deno.readDirSync(`${d}/backups`)].map((e) => e.name), [stampOf(at(1))]);
});

Deno.test("backups: restore puts a copy back, keeps the replaced file, and knows only this server's names", async () => {
  const d = dataDir();
  const run = await backupAll(d, KEY, 7, at(1));
  const file = tenantFile(d, "alice");
  const s = new Store(file);
  s.write("later.md", "# later", "test");
  s.close();

  assertEquals(restoreTarget(d, `${run.dir}/alice.brn`), file);
  assertEquals(restoreTarget(d, `${run.dir}/accounts.db.brn`), `${d}/accounts.db`);
  for (const bad of ["Brain.brn", "a.b.brn", "alice.txt"]) assert(!tryTarget(d, bad), bad);
  await assertRejects(() => restoreCopy(d, `${run.dir}/alice.brn`, btoa(String.fromCharCode(...new Uint8Array(32)))));

  await restoreCopy(d, `${run.dir}/alice.brn`, KEY);
  const back = new Store(file);
  assert(back.get("note.md") && !back.get("later.md"));
  back.close();
  const old = new Store(`${file}.pre-restore`);
  assert(old.get("later.md"));
  old.close();
});

const tryTarget = (d: string, f: string) => {
  try {
    return restoreTarget(d, f);
  } catch {
    return null;
  }
};
