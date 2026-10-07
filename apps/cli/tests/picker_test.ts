// Tests for the profile picker's endpoint (console/picker.ts): it lists what the manifests declare and
// opens only a declared profile. The launcher is injected: no Claude Desktop is ever started here.
import { assertEquals } from "jsr:@std/assert@1";
import { launchers } from "../lib/profiles.ts";
import { launchList, launchOne } from "../console/picker.ts";

Deno.test("picker: the list is the manifests' profiles and launchers, in order", async () => {
  const want = (await launchers()).map(({ profile, command }) => ({ profile, command }));
  assertEquals((await launchList()).profiles, want);
  assertEquals(want.length > 0, true);
});

Deno.test("picker: a declared profile goes through claude-launch; anything else starts nothing", async () => {
  const started: string[][] = [];
  const start = (bin: string, args: string[]) => {
    started.push([bin.split("/").pop()!, ...args]);
    return Promise.resolve();
  };
  const known = (await launchers())[0].profile;
  assertEquals(await launchOne({ profile: known }, start), { ok: true });
  assertEquals(started, [["claude-launch", known]]);

  for (const body of [{ profile: "../x" }, { profile: "nope" }, { profile: 3 }, {}, null]) {
    assertEquals((await launchOne(body, start)).ok, false);
  }
  assertEquals(started.length, 1);
});
