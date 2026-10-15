// Tests for `agents init`: a configuration made from config.example/ and linked, never over
// something else.
import { assert, assertEquals } from "jsr:@std/assert@1";

Deno.test("idFrom: lower case, no accents, letters and digits", async () => {
  const { idFrom } = await import("../init.ts");
  assertEquals(idFrom("Àlvaro Núñez"), "alvaronunez");
  assertEquals(idFrom("—"), "me");
});

Deno.test("init: copies the example, sets the owner, links it; a second time only links", async () => {
  // the link is made in a throwaway place, never at the real ~/.agents-multi/config
  const root = await Deno.makeTempDir();
  const { init } = await import("../init.ts");
  const CONFIG = `${root}/runtime/config`;
  assertEquals(await init([`${root}/cfg`, "--name", "Ann", "--language", "Italian"], CONFIG), 0);
  assertEquals(JSON.parse(await Deno.readTextFile(`${root}/cfg/owner.json`)), {
    id: "ann",
    name: "Ann",
    language: "Italian",
  });
  assert(await Deno.stat(`${root}/cfg/profiles/personal/profile.json`));
  assertEquals(await Deno.readLink(CONFIG), `${root}/cfg`);
  assertEquals(await init([`${root}/cfg`], CONFIG), 0);
  assertEquals(await init([`${root}/other`], CONFIG), 1); // the link points elsewhere: refused, nothing made
  assertEquals(await Deno.stat(`${root}/other`).then(() => true, () => false), false);
});

Deno.test("withBrainAccount: added when there is none, else left as it is", async () => {
  const { withBrainAccount } = await import("../init.ts");
  const brain = { service: "brain", name: "brain", url: "https://b.example" };
  assertEquals(withBrainAccount({ accounts: [] }, "https://b.example"), { accounts: [brain] });
  assertEquals(withBrainAccount({}, "https://b.example"), { accounts: [brain] });
  const own = { "$note": "x", accounts: [{ service: "brain", name: "mine", url: "https://other" }] };
  assertEquals(withBrainAccount(own, "https://b.example"), own);
});

Deno.test("init --brain: the account is written; a bad address writes nothing", async () => {
  const root = await Deno.makeTempDir();
  const { init } = await import("../init.ts");
  const CONFIG = `${root}/runtime/config`;
  assertEquals(await init([`${root}/bad`, "--brain", "http://brain.example"], CONFIG), 2);
  assertEquals(await Deno.stat(`${root}/bad`).then(() => true, () => false), false);
  assertEquals(await init([`${root}/cfg`, "--name", "Ann", "--brain", "https://brain.example/x"], CONFIG), 0);
  const accounts = JSON.parse(await Deno.readTextFile(`${root}/cfg/accounts.json`)).accounts;
  assertEquals(accounts.filter((a: { service: string }) => a.service === "brain"), [
    { service: "brain", name: "brain", url: "https://brain.example" },
  ]);
});
