// Tests for the admin CLI (admin.ts) against a temporary data directory: the same operations as the
// administrator's page, plus delete, stats, backup and restore.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { admin, type AdminConfig } from "../admin.ts";
import { Auth } from "../auth.ts";
import { Store } from "../store.ts";
import { tenantFile } from "../tenants.ts";
import { masterKey, Users } from "../users.ts";

const MASTER = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const BACKUP = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

function setup() {
  const data = Deno.makeTempDirSync();
  const cfg: AdminConfig = {
    data,
    masterKey: MASTER,
    url: "https://b.test",
    backupKey: BACKUP,
    keep: 7,
    serving: () => Promise.resolve(false),
  };
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await admin(argv, cfg, (l) => lines.push(l));
    return { code, text: lines.join("\n") };
  };
  /** The accounts as the server would read them, through its own classes. */
  const open = async () => {
    const db = new DatabaseSync(`${data}/accounts.db`);
    db.exec("pragma busy_timeout = 5000");
    const users = new Users(db, await masterKey(MASTER));
    return { db, users, auth: new Auth(db, users, { url: "https://b.test" }) };
  };
  /** A brain for an account, with these documents. */
  const brain = (id: string, ...paths: string[]) => {
    Deno.mkdirSync(`${data}/users/${id}`, { recursive: true });
    const s = new Store(tenantFile(data, id));
    for (const p of paths) s.write(p, `# ${p}`, "test");
    s.close();
  };
  const has = (id: string, path: string) => {
    const s = new Store(tenantFile(data, id));
    try {
      return !!s.get(path);
    } finally {
      s.close();
    }
  };
  return { cfg, run, open, brain, has, data };
}
const tokenOf = (text: string) => text.match(/invite\?t=(\S+)/)![1];

Deno.test("admin: create prints a one-time invitation, list shows the account, ids are lowercased", async () => {
  const { run, open } = setup();
  const r = await run("create", "Bob", "Bob", "Builder", "--language", "English");
  assert(r.text.includes("https://b.test/invite?t="), r.text);
  const { db, users } = await open();
  const u = users.get("bob")!;
  assertEquals([u.name, u.language, u.ready], ["Bob Builder", "English", false]);
  assertEquals((await users.invitation(tokenOf(r.text)))?.user.id, "bob");
  db.close();
  assert((await run("list")).text.includes("invited"));
  await assertRejects(() => run("create", "bob", "Again"), Error, "esiste già");
  await assertRejects(() => run("create", "bob"), Error, "usage");
  assertEquals((await run("bogus")).code, 2);
});

Deno.test("admin: disable cuts the tokens, enable lets the account in again, the administrator stays", async () => {
  const { run, open } = setup();
  await run("create", "root", "Root");
  await run("create", "bob", "Bob");
  const { db, auth } = await open();
  const token = await auth.createPersonal("bob", "laptop");
  db.exec("update users set admin = 1 where id = 'root'");
  db.close();

  await run("disable", "bob");
  const after = await open();
  assertEquals(after.users.get("bob")!.disabled, true);
  assertEquals(
    await after.auth.caller(new Request("https://b.test/mcp", { headers: { authorization: `Bearer ${token}` } })),
    null,
  );
  after.db.close();
  await assertRejects(() => run("disable", "root"), Error, "amministratore");
  await run("enable", "bob");
  const again = await open();
  assertEquals(again.users.get("bob")!.disabled, false);
  again.db.close();
  await assertRejects(() => run("disable", "ghost"), Error, "no account");
});

Deno.test("admin: reset clears the lock and every way in and prints a new invitation; unlock only the lock", async () => {
  const { run, open } = setup();
  await run("create", "bob", "Bob");
  const failures = (db: DatabaseSync) => (db.prepare("select count(*) n from login_failures").get() as { n: number }).n;
  const fail = (db: DatabaseSync) =>
    db.prepare("insert into login_failures (user, ip, at) values ('bob', '1.1.1.1', ?)").run(Date.now());
  const a = await open();
  fail(a.db);
  a.db.close();
  await run("unlock", "bob");
  const b = await open();
  assertEquals(failures(b.db), 0);
  fail(b.db);
  b.db.close();

  const r = await run("reset", "bob");
  const c = await open();
  assertEquals(failures(c.db), 0);
  assertEquals((await c.users.invitation(tokenOf(r.text)))?.user.id, "bob");
  c.db.close();
});

Deno.test("admin: delete needs --yes, removes account, tokens and brain, and refuses the administrator", async () => {
  const { run, open, brain, data } = setup();
  await run("create", "root", "Root");
  await run("create", "bob", "Bob");
  const a = await open();
  await a.auth.createPersonal("bob", "laptop");
  a.db.exec("update users set admin = 1 where id = 'root'");
  a.db.close();
  brain("bob", "a.md");

  await assertRejects(() => run("delete", "bob"), Error, "--yes");
  assert(Deno.statSync(tenantFile(data, "bob")));
  await assertRejects(() => run("delete", "root", "--yes"), Error, "amministratore");

  await run("delete", "bob", "--yes");
  const b = await open();
  assertEquals(b.users.get("bob"), null);
  assertEquals(b.auth.personalTokens("bob").length, 0);
  b.db.close();
  assertEquals([...Deno.readDirSync(`${data}/users`)].length, 0);
});

Deno.test("admin: stats counts pages and tasks apart", async () => {
  const { run, brain } = setup();
  await run("create", "bob", "Bob");
  await run("create", "eve", "Eve");
  brain("bob", "a.md", "b.md", "tasks/t-1.md");
  const text = (await run("stats")).text;
  assert(/bob\s+2 pages\s+1 tasks/.test(text), text);
  assert(/eve\s+no brain yet/.test(text), text);
  assert(text.startsWith("accounts.db"), text);
});

Deno.test("admin: backup needs the key and makes a run; restore refuses a running server unless --yes", async () => {
  const { cfg, run, brain, has, data } = setup();
  await run("create", "bob", "Bob");
  brain("bob", "a.md");

  cfg.backupKey = undefined;
  await assertRejects(() => run("backup"), Error, "BRAIN_BACKUP_KEY");
  cfg.backupKey = BACKUP;
  const r = await run("backup");
  assert(r.text.includes("accounts.db.brn, bob.brn"), r.text);
  const copy = `${data}/backups/${[...Deno.readDirSync(`${data}/backups`)][0].name}/bob.brn`;
  brain("bob", "later.md");

  cfg.serving = () => Promise.resolve(true);
  await assertRejects(() => run("restore", copy), Error, "server is running");
  assert(has("bob", "later.md"));
  await run("restore", copy, "--yes");
  assert(has("bob", "a.md") && !has("bob", "later.md"));
});
