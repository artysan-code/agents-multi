// Tests for the schema versions (migrate.ts) and for the purge of expired rows (auth.ts, users.ts).
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { ACCOUNTS_MIGRATIONS, Auth } from "../auth.ts";
import { migrate } from "../migrate.ts";
import { BRAIN_MIGRATIONS, Store } from "../store.ts";
import { masterKey, Users } from "../users.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const version = (db: DatabaseSync) =>
  (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;

Deno.test("migrate: a fresh database ends at the latest version, and opening again changes nothing", async () => {
  const db = new DatabaseSync(":memory:");
  new Auth(db, new Users(db, await masterKey(KEY)), { url: "https://b.test" });
  assertEquals(version(db), ACCOUNTS_MIGRATIONS.length);
  const file = await Deno.makeTempFile();
  try {
    new Store(file).db.close();
    const s = new Store(file);
    assertEquals(version(s.db), BRAIN_MIGRATIONS.length);
    s.db.close();
  } finally {
    await Deno.remove(file).catch(() => {});
  }
});

Deno.test("migrate: a failing step rolls back, a newer database is refused", () => {
  const db = new DatabaseSync(":memory:");
  const steps = [
    (d: DatabaseSync) => d.exec("create table a (x)"),
    (d: DatabaseSync) => {
      d.exec("create table b (x)");
      throw new Error("boom");
    },
  ];
  assertThrows(() => migrate(db, steps), Error, "boom");
  // step 1 stayed (its own transaction), step 2 left nothing behind
  assertEquals(version(db), 1);
  assertEquals(db.prepare("select name from sqlite_master where name = 'b'").all().length, 0);
  assertThrows(() => migrate(db, []), Error, "schema version 1");
});

Deno.test("migrate: accounts.db from before versions keeps its data and gains what it lacked", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    create table users (id text primary key, name text not null, language text not null, pass text, totp text, backup text not null,
      admin integer not null default 0, disabled integer not null default 0, created text not null);
    create table invites (hash text primary key, user text not null, expires integer not null);
    create table oauth_clients (id text primary key, name text, redirects text not null, created text not null);
    create table oauth_codes (hash text primary key, user text not null, client text not null, redirect text not null, challenge text not null, resource text, expires integer not null);
    create table tokens (hash text primary key, user text not null, kind text not null, client text, name text, family text, expires integer,
      created text not null, used text, revoked integer not null default 0);
    create table sessions (hash text primary key, user text not null, expires integer not null);
    create table login_failures (user text not null, at integer not null);
    insert into users (id, name, language, backup, created) values ('bob', 'Bob', 'Italian', 'k', '2026-01-01');
    insert into oauth_clients values ('c1', 'Claude', '[]', '2026-01-01');
    insert into tokens (hash, user, kind, client, expires, created) values ('h', 'bob', 'access', 'c1', null, '2026-01-01');
    insert into oauth_codes values ('code', 'bob', 'c1', 'r', 'ch', null, 1);
  `);
  assertEquals(version(db), 0);
  const users = new Users(db, await masterKey(KEY));
  new Auth(db, users, { url: "https://b.test" });
  assertEquals(version(db), ACCOUNTS_MIGRATIONS.length);
  assertEquals(users.get("bob")?.timezone, null);
  assertEquals(count(db, "oauth_clients"), 1);
  assertEquals(count(db, "tokens"), 1);
  assertEquals(count(db, "oauth_codes"), 1);
  // the columns that were missing are there
  db.prepare("insert into sessions (hash, user, expires, ends) values ('s', 'bob', 1, 1)").run();
  db.prepare("insert into login_failures (user, ip, at) values ('bob', '1.2.3.4', 1)").run();
  db.prepare("update oauth_codes set scope = 'brain'").run();
});

Deno.test("migrate: a brain database from before versions is stamped, its documents untouched", async () => {
  const file = await Deno.makeTempFile();
  try {
    const s = new Store(file);
    s.write("a/b.md", "# Hi", "test");
    s.db.exec("pragma user_version = 0");
    s.db.close();
    const again = new Store(file);
    assertEquals(version(again.db), BRAIN_MIGRATIONS.length);
    assertEquals(again.get("a/b.md")?.body, "# Hi");
    again.db.close();
  } finally {
    await Deno.remove(file).catch(() => {});
  }
});

Deno.test("purge: expired rows go, valid ones stay", async () => {
  const db = new DatabaseSync(":memory:");
  const users = new Users(db, await masterKey(KEY));
  const auth = new Auth(db, users, { url: "https://b.test" });
  const now = Date.now(), day = 86_400_000;
  const iso = (t: number) => new Date(t).toISOString();
  db.prepare("insert into oauth_clients values ('live', 'x', '[]', ?)").run(iso(now));
  const tok = db.prepare(
    "insert into tokens (hash, user, kind, client, expires, created) values (?, 'bob', 'access', 'live', ?, ?)",
  );
  tok.run("fresh", now + 1000, iso(now));
  tok.run("recent", now - day, iso(now - day)); // expired, but inside the grace the client rules rely on
  tok.run("old", now - 91 * day, iso(now - 92 * day));
  db.prepare("insert into tokens (hash, user, kind, created) values ('personal', 'bob', 'access', ?)").run(iso(now));
  const code = db.prepare(
    "insert into oauth_codes (hash, user, client, redirect, challenge, expires) values (?, 'bob', 'live', 'r', 'c', ?)",
  );
  code.run("c-live", now + 1000);
  code.run("c-dead", now - 1000);
  const ses = db.prepare("insert into sessions (hash, user, expires, ends) values (?, 'bob', ?, ?)");
  ses.run("s-live", now + 1000, now + 2000);
  ses.run("s-dead", now - 1000, now + 2000);
  const fail = db.prepare("insert into login_failures (user, ip, at) values ('bob', ?, ?)");
  fail.run("new", now);
  fail.run("old", now - 16 * 60_000);
  db.prepare("insert into invites values ('i-live', 'bob', ?)").run(now + 1000);
  db.prepare("insert into invites values ('i-dead', 'bob', ?)").run(now - 1000);

  assertEquals(auth.purge(now), 4); // the old token, the dead code, the dead session, the old failure
  assertEquals(users.purge(now), 1);
  const names = (sql: string) => (db.prepare(sql).all() as { h: string }[]).map((r) => r.h).sort();
  assertEquals(names("select hash h from tokens"), ["fresh", "personal", "recent"]);
  assertEquals(names("select hash h from oauth_codes"), ["c-live"]);
  assertEquals(names("select hash h from sessions"), ["s-live"]);
  assertEquals(names("select ip h from login_failures"), ["new"]);
  assertEquals(names("select hash h from invites"), ["i-live"]);
  assertEquals(names("select id h from oauth_clients"), ["live"]);
  assertEquals(auth.purge(now), 0);
});
