// Tests for the brain's people: accounts and invitations (users.ts), signing in and tokens bound to
// an account (auth.ts), and each person's own database (tenants.ts) — above all, that nothing of one
// account is reachable from another.
import { assert, assertEquals, assertNotEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { Auth, base32Encode, sha256, totp } from "../auth.ts";
import { accountError, hashPassphrase, masterKey, passphraseOk, Users } from "../users.ts";
import { tenantFile, Tenants } from "../tenants.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const PASS = "una passphrase lunga";
async function fresh(dev = false) {
  const db = new DatabaseSync(":memory:");
  const users = new Users(db, await masterKey(KEY), dev);
  return { db, users, auth: new Auth(db, users, { url: "https://b.test" }) };
}
/** An invited account made ready, as its person would: the TOTP secret from the page, a code from it. */
async function ready(users: Users, id: string) {
  const link = await users.invite(id, id.toUpperCase(), "Italian");
  const inv = (await users.invitation(link))!;
  const r = await users.accept(link, PASS, await totp(inv.totpSecret));
  assert(typeof r !== "string", String(r));
  return inv.totpSecret;
}
const bearer = (t: string) => new Request("https://b.test/mcp", { headers: { authorization: `Bearer ${t}` } });

Deno.test("accounts: ids and names, the master key, passphrase hashes", async () => {
  assertEquals(accountError("bob", "Bob"), null);
  for (const bad of ["Bob", "1abc", "a", "../x", "a b", "x".repeat(40)]) assert(accountError(bad, "N"), bad);
  assert(accountError("ok", " "));
  await assertRejects(() => masterKey(btoa("short")), Error, "32 bytes");
  const h = await hashPassphrase(PASS);
  assert(h.startsWith("pbkdf2$") && !h.includes(PASS));
  assert(await passphraseOk(PASS, h));
  assert(!(await passphraseOk("un'altra passphrase", h)));
});

Deno.test("invitations: one use, a TOTP code proves the secret, a short passphrase refused", async () => {
  const { users } = await fresh();
  const link = await users.invite("bob", "Bob", "Italian");
  assertEquals(users.get("bob")?.ready, false);
  await assertRejects(() => users.invite("bob", "Bob", "Italian"), Error, "esiste già");
  const inv = (await users.invitation(link))!;
  assertEquals(inv.user.id, "bob");
  assertEquals(await users.accept(link, "corta", await totp(inv.totpSecret)), "la passphrase ha almeno 12 caratteri");
  assert(/codice/.test(String(await users.accept(link, PASS, "000000"))));
  assertEquals((await users.accept(link, PASS, await totp(inv.totpSecret)) as { ready: boolean }).ready, true);
  assertEquals(await users.invitation(link), null);
  assert(await users.verify("bob", PASS, await totp(inv.totpSecret)));
  assert(!(await users.verify("bob", PASS, "000000")));
  assert(!(await users.verify("nobody", PASS, "000000")));
});

Deno.test("accounts: a new invitation clears the way in but keeps the backup key; disabled accounts do not sign in", async () => {
  const { users } = await fresh();
  const secret = await ready(users, "ann");
  const key = await users.backupKey("ann");
  assertEquals(atob(key).length, 32);
  const link = await users.reinvite("ann");
  assertEquals(users.get("ann")?.ready, false);
  assert(!(await users.verify("ann", PASS, await totp(secret))));
  assertEquals(await users.backupKey("ann"), key);
  const inv = (await users.invitation(link))!;
  assertNotEquals(inv.totpSecret, secret);
  await users.accept(link, PASS, await totp(inv.totpSecret));
  users.setDisabled("ann", true);
  assert(!(await users.verify("ann", PASS, await totp(inv.totpSecret))));
  users.setDisabled("ann", false);
  assert(await users.verify("ann", PASS, await totp(inv.totpSecret)));
});

Deno.test("bootstrap: the first account is the administrator with the credentials it had; only once", async () => {
  const { users } = await fresh();
  const secret = base32Encode(crypto.getRandomValues(new Uint8Array(20)));
  await users.bootstrap({ id: "samuel", name: "Samuel", language: "Italian", passphrase: PASS, totpSecret: secret, backupKey: KEY });
  await users.bootstrap({ id: "other", name: "Other", language: "Italian", passphrase: PASS, totpSecret: secret });
  assertEquals(users.list().map((u) => [u.id, u.admin, u.ready]), [["samuel", true, true]]);
  assertEquals(await users.backupKey("samuel"), KEY);
  assert(await users.verify("samuel", PASS, await totp(secret)));
  assertThrows(() => users.setDisabled("samuel", true), Error, "amministratore");
});

Deno.test("sign in: per account, five wrong attempts lock that account only", async () => {
  const { users, auth } = await fresh();
  const a = await ready(users, "ann"), b = await ready(users, "bob");
  assertEquals(await auth.signIn("ann", PASS, await totp(a)), "ok");
  for (let i = 0; i < 5; i++) assertEquals(await auth.signIn("ann", "sbagliata!!!!", "000000"), "wrong");
  assertEquals(await auth.signIn("ann", PASS, await totp(a)), "locked");
  assertEquals(await auth.signIn("bob", PASS, await totp(b)), "ok");
  assertEquals(await auth.signIn(" BOB ", PASS, await totp(b)), "ok");
});

Deno.test("tokens: each belongs to its account; one account cannot revoke another's; disabled means no way in", async () => {
  const { users, auth } = await fresh();
  await ready(users, "ann");
  await ready(users, "bob");
  const ta = await auth.createPersonal("ann", "fisso"), tb = await auth.createPersonal("bob", "portatile");
  assertEquals(await auth.caller(bearer(ta)), { user: "ann", label: "token:fisso" });
  assertEquals(await auth.caller(bearer(tb)), { user: "bob", label: "token:portatile" });
  assertEquals(auth.personalTokens("ann").map((t) => t.name), ["fisso"]);
  auth.revoke("bob", await sha256(ta)); // bob names ann's token: nothing happens
  assertEquals((await auth.caller(bearer(ta)))?.user, "ann");
  users.setDisabled("bob", true);
  assertEquals(await auth.caller(bearer(tb)), null);
  users.setDisabled("bob", false);
  auth.revokeAll("bob");
  assertEquals(await auth.caller(bearer(tb)), null);
  assertEquals((await auth.caller(bearer(ta)))?.user, "ann");
});

Deno.test("OAuth: the code carries the account that signed in to the tokens", async () => {
  const { users, auth } = await fresh();
  await ready(users, "ann");
  const reg = auth.register({ redirect_uris: ["http://127.0.0.1/cb"], client_name: "Claude Code" }).json as { client_id: string };
  const verifier = "v".repeat(43);
  const enc = new TextEncoder();
  const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const q = new URLSearchParams({ client_id: reg.client_id, redirect_uri: "http://127.0.0.1:5000/cb", code_challenge: challenge, response_type: "code", code_challenge_method: "S256" });
  const code = new URL(await auth.issueCode(q, "ann")).searchParams.get("code")!;
  const r = await auth.token(new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:5000/cb", code_verifier: verifier }));
  const tok = r.json as { access_token: string; refresh_token: string };
  assertEquals(await auth.caller(bearer(tok.access_token)), { user: "ann", label: "claude:Claude Code" });
  assertEquals(auth.connections("ann").length, 1);
  assertEquals(auth.connections("bob").length, 0);
  users.setDisabled("ann", true);
  const again = await auth.token(new URLSearchParams({ grant_type: "refresh_token", refresh_token: tok.refresh_token }));
  assertEquals(again.status, 400);
});

Deno.test("adopt: the live tokens of a one-person brain become the first account's", async () => {
  const { users, auth } = await fresh();
  await ready(users, "samuel");
  const old = new DatabaseSync(":memory:");
  old.exec(`create table oauth_clients (id text primary key, name text, redirects text not null, created text not null);
    create table tokens (hash text primary key, kind text not null, client text, name text, family text, expires integer, created text not null, used text, revoked integer not null default 0);`);
  old.prepare("insert into oauth_clients values ('c1', 'Claude', '[]', 'x')").run();
  const live = "brain_live", gone = "brain_gone";
  old.prepare("insert into tokens (hash, kind, name, created, revoked) values (?, 'personal', 'fisso', 'x', 0)").run(await sha256(live));
  old.prepare("insert into tokens (hash, kind, name, created, revoked) values (?, 'personal', 'vecchio', 'x', 1)").run(await sha256(gone));
  assertEquals(auth.adopt(old, "samuel"), 1);
  assertEquals(await auth.caller(bearer(live)), { user: "samuel", label: "token:fisso" });
  assertEquals(await auth.caller(bearer(gone)), null);
  assertEquals(auth.client("c1")?.name, "Claude");
});

Deno.test("tenants: one file per account, ids that are not accounts refused, nothing shared", async () => {
  assertEquals(tenantFile("/data/", "ann"), "/data/users/ann/brain.db");
  for (const bad of ["../ann", "Ann", "a/b", "", "ann\0"]) assertThrows(() => tenantFile("/data", bad), Error, "not an account id");
  const dir = await Deno.makeTempDir();
  const t = new Tenants(dir, { url: "http://127.0.0.1:1", model: "none" }, () => "test");
  const a = t.open("ann"), b = t.open("bob");
  assert(a === t.open("ann") && a.file !== b.file);
  a.store.write("io/chi-sono.md", "# Ann\n\nAnn.", "test");
  assertEquals(b.store.get("io/chi-sono.md"), null);
  await a.tasks.write({ id: "t-20261005-aaaaaa", title: "solo di ann", status: "todo", created: "c", updated: "u" });
  assertEquals((await b.tasks.list()).length, 0);
  assertEquals((await a.tasks.list()).map((x) => x.title), ["solo di ann"]);
  await new Promise((r) => setTimeout(r, 50)); // the indexers' first try at the (absent) model
  t.close();
});

Deno.test("invite: the first account of a new service is the administrator, invited like anyone else", async () => {
  const { users } = await fresh();
  const link = await users.invite("samuel", "Samuel", "Italian", true);
  assertEquals([users.get("samuel")?.admin, users.get("samuel")?.ready], [true, false]);
  const inv = (await users.invitation(link))!;
  await users.accept(link, PASS, await totp(inv.totpSecret));
  assertEquals(users.get("samuel")?.ready, true);
  assertEquals((await users.invite("ann", "Ann", "Italian")).length > 20 && users.get("ann")?.admin, false);
});
