// pair_test.ts — pairing a machine with a code (pair.ts, ADR 0014 G4): the code's format and how a typed one is
// read, one use, ten minutes, the token handed over once and named after the machine, the lockout after five wrong
// codes, and the routes' rate buckets.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { DatabaseSync } from "node:sqlite";
import { Auth } from "../auth.ts";
import { masterKey, Users } from "../users.ts";
import {
  LOCK_MS,
  MAX_OPEN,
  MAX_WRONG,
  newCode,
  normalCode,
  PAIR_TTL_MS,
  PairError,
  Pairings,
  showCode,
} from "../pair.ts";
import { totp } from "../crypto.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

async function setup() {
  let now = Date.parse("2026-10-15T20:00:00Z");
  const db = new DatabaseSync(":memory:");
  const users = new Users(db, await masterKey(KEY), false);
  const auth = new Auth(db, users, { url: "https://b.test" });
  for (const id of ["ann", "bob"]) {
    const link = await users.invite(id, id, "Italian");
    const inv = (await users.invitation(link))!;
    assert(
      typeof await users.accept(
        link,
        "una passphrase lunga",
        await totp(inv.totpSecret),
      ) !== "string",
    );
  }
  const pairings = new Pairings(db, auth, users, "https://b.test", () => now);
  return { db, auth, users, pairings, tick: (ms: number) => (now += ms) };
}

Deno.test("pair: codes are eight characters of Crockford base32, shown XXXX-XXXX", () => {
  for (let i = 0; i < 200; i++) {
    assert(/^[0-9A-HJKMNP-TV-Z]{8}$/.test(newCode()));
  }
  assertEquals(showCode("ABCD2345"), "ABCD-2345");
  assertEquals(new Set(Array.from({ length: 50 }, newCode)).size, 50);
});

Deno.test("pair: a typed code is read tolerantly: case, dash, spaces, Crockford's look-alikes", () => {
  for (const t of ["abcd-2345", "ABCD2345", " abcd 2345 ", "AB-CD-23-45"]) {
    assertEquals(normalCode(t), "ABCD2345", t);
  }
  assertEquals(normalCode("OIL0-1111"), "01101111");
  for (
    const bad of [
      "",
      "ABCD-234",
      "ABCD-23456",
      "ABCU-2345",
      "ABC!-2345",
      12345678,
      null,
      "A".repeat(100),
    ]
  ) {
    assertEquals(normalCode(bad), null, String(bad));
  }
});

Deno.test("pair: the machine polls, the person claims, the token comes once and is named after the machine", async () => {
  const { pairings, auth, db } = await setup();
  const p = await pairings.create("My Laptop (old)", "linux");
  assert(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(p.code));
  assertEquals(p.pairing.length, 43); // 32 bytes, base64url
  assertEquals(await pairings.poll(p.pairing), { state: "waiting" });
  // stored hashed: neither the code nor the secret is in the table
  const rows = JSON.stringify(db.prepare("select * from pairings").all());
  assert(!rows.includes(p.pairing) && !rows.includes(p.code.replace("-", "")));
  // the code first shows which machine asks, and binds nothing
  const seen = await pairings.claim("ann", p.code);
  assert("preview" in seen);
  assertEquals([seen.preview.node, seen.preview.platform], ["My-Laptop-old-", "linux"]);
  assertEquals(await pairings.poll(p.pairing), { state: "waiting" });
  assertEquals(
    await pairings.claim("ann", p.code.toLowerCase().replace("-", " "), true),
    { node: "My-Laptop-old-" },
  );
  const done = await pairings.poll(p.pairing);
  assert(done.state === "done");
  assertEquals(done.url, "https://b.test");
  assert(done.token.startsWith("brain_"));
  // the token is the account's own personal token, named after the machine, and it works
  assertEquals(auth.personalTokens("ann").map((t) => t.name), [
    "My-Laptop-old-",
  ]);
  const who = await auth.caller(
    new Request("https://b.test/api/nodes", {
      headers: { authorization: `Bearer ${done.token}` },
    }),
  );
  assertEquals(who, { user: "ann", label: "token:My-Laptop-old-" });
  // once only
  assertEquals(await pairings.poll(p.pairing), { state: "expired" });
  assertEquals(auth.personalTokens("bob"), []);
});

Deno.test("pair: one use, ten minutes", async () => {
  const { pairings, tick } = await setup();
  const a = await pairings.create("a", "linux");
  await pairings.claim("ann", a.code, true);
  await assertRejects(
    () => pairings.claim("bob", a.code),
    PairError,
    "unknown or expired",
  );
  const b = await pairings.create("b", "linux");
  tick(PAIR_TTL_MS + 1);
  await assertRejects(
    () => pairings.claim("ann", b.code),
    PairError,
    "unknown or expired",
  );
  assertEquals(await pairings.poll(b.pairing), { state: "expired" });
  assertEquals(await pairings.poll("x".repeat(43)), { state: "expired" });
});

Deno.test("pair: five wrong codes in a row lock an account's claiming for fifteen minutes", async () => {
  const { pairings, tick } = await setup();
  const p = await pairings.create("m", "linux");
  for (let i = 0; i < MAX_WRONG; i++) {
    await assertRejects(
      () => pairings.claim("ann", "ZZZZ-ZZZZ"),
      PairError,
      "unknown or expired",
    );
  }
  // locked: even the right code is refused, with 429
  const e = await assertRejects(
    () => pairings.claim("ann", p.code),
    PairError,
    "too many",
  );
  assertEquals((e as PairError).status, 429);
  // another account is not locked
  assertEquals((await pairings.claim("bob", p.code, true) as { node: string }).node, "m");
  tick(LOCK_MS + 1);
  const q = await pairings.create("n", "linux");
  assertEquals((await pairings.claim("ann", q.code, true) as { node: string }).node, "n");
});

Deno.test("pair: a right code in between resets the count; a malformed one counts as wrong", async () => {
  const { pairings } = await setup();
  for (let i = 0; i < MAX_WRONG - 1; i++) {
    await assertRejects(() => pairings.claim("ann", "nonsense"), PairError);
  }
  await pairings.claim("ann", (await pairings.create("m", "linux")).code, true);
  for (let i = 0; i < MAX_WRONG - 1; i++) {
    await assertRejects(() => pairings.claim("ann", "ZZZZ-ZZZZ"), PairError);
  }
  assert(!pairings.locked("ann"));
  await assertRejects(() => pairings.claim("ann", "ZZZZ-ZZZZ"), PairError);
  assert(pairings.locked("ann"));
});

Deno.test("pair: a name is required and the table is bounded", async () => {
  const { pairings, db } = await setup();
  await assertRejects(() => pairings.create("  ", "linux"), PairError, "name");
  await assertRejects(
    () => pairings.create(undefined, "linux"),
    PairError,
    "name",
  );
  db.exec("begin");
  const ins = db.prepare(
    "insert into pairings (code, secret, name, platform, expires) values (?, ?, 'x', 'linux', ?)",
  );
  for (let i = 0; i < MAX_OPEN; i++) {
    ins.run(`c${i}`, `s${i}`, Date.parse("2026-10-15T21:00:00Z"));
  }
  db.exec("commit");
  const e = await assertRejects(() => pairings.create("m", "linux"), PairError);
  assertEquals((e as PairError).status, 503);
});

Deno.test("pair: a disabled account gets no token, and purging forgets what expired", async () => {
  const { pairings, users, auth, tick, db } = await setup();
  const p = await pairings.create("m", "linux");
  await pairings.claim("ann", p.code, true);
  users.setDisabled("ann", true);
  assertEquals(await pairings.poll(p.pairing), { state: "expired" });
  await pairings.create("old", "linux");
  tick(PAIR_TTL_MS + 1);
  auth.purge(Date.parse("2026-10-15T20:00:00Z") + PAIR_TTL_MS + 1);
  assertEquals(
    (db.prepare("select count(*) n from pairings").get() as { n: number }).n,
    0,
  );
});
