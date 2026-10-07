// Tests for the guided repair: the steps a check offers name actions of the console's allowlist, and
// the server refuses a parameter it does not know (nothing free is ever executed).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { type ActionDef, ACTIONS, manualCommand, resolveAction } from "../console/actions.ts";
import { createHandler, routes } from "../console/server.ts";
import { StatusCache } from "../console/status-cache.ts";
import { failedVariants } from "../doctor/checks/updates.ts";
import { actionStep } from "../doctor/repair.ts";

const defs: Record<string, ActionDef> = {
  ...ACTIONS,
  "desktop-rebuild": {
    ...ACTIONS["desktop-rebuild"],
    param: { name: "profile", allowed: () => Promise.resolve(["alice"]) },
  },
};
const entry = (event: string, detail: string, component = "desktop") => ({
  at: "",
  component,
  event,
  from: "",
  to: "",
  detail,
});

Deno.test("repair: every action a check names exists in the allowlist", async () => {
  const dir = new URL("../doctor/checks/", import.meta.url);
  const named: string[] = [];
  for await (const f of Deno.readDir(dir)) {
    const src = await Deno.readTextFile(new URL(f.name, dir));
    for (const m of src.matchAll(/actionStep\("([^"]+)"/g)) named.push(m[1]);
  }
  assert(named.length > 0);
  assertEquals(named.filter((n) => !(n in ACTIONS)), []);
});

Deno.test("repair: a parametric action takes only a value the server knows", async () => {
  const ok = await resolveAction("desktop-rebuild", [], { profile: "alice" }, defs);
  assert(!("error" in ok) && ok.cmd.endsWith("/bin/claude-desktop-rebuild"));
  assertEquals(ok.args, ["alice"]);
  const refused: Record<string, string>[] = [
    { profile: "bob" },
    { profile: "alice; rm -rf ~" },
    { profile: "--help" },
    {},
    { other: "alice" },
  ];
  for (const params of refused) {
    const r = await resolveAction("desktop-rebuild", [], params, defs);
    assert("error" in r, JSON.stringify(params));
  }
});

Deno.test("repair: an action without a parameter refuses one, and an unknown name runs nothing", async () => {
  assert("error" in await resolveAction("doctor", [], { profile: "alice" }, defs));
  assert("error" in await resolveAction("rm", [], {}, defs));
  assert("error" in await resolveAction("constructor", [], {}, defs));
});

Deno.test("repair: the command to run by hand matches the action", () => {
  assertEquals(manualCommand("mcp-sync"), "agents mcp sync");
  assertEquals(actionStep("desktop-rebuild", { profile: "alice" }), {
    kind: "action",
    action: "desktop-rebuild",
    args: { profile: "alice" },
    cmd: "claude-desktop-rebuild alice",
  });
});

Deno.test("failedVariants: the failing profiles of the last Desktop update, minus those rebuilt since", () => {
  const failed = entry("failed", "variant rebuild failed: alice: no space left; bob: bad asar; ghost: x");
  const known = ["alice", "bob"];
  assertEquals(failedVariants([failed], known), [
    { profile: "alice", why: "no space left" },
    { profile: "bob", why: "bad asar" },
  ]);
  assertEquals(failedVariants([entry("rebuilt", "alice"), failed], known).map((v) => v.profile), ["bob"]);
  assertEquals(failedVariants([entry("rebuilt", "bob"), entry("rebuilt", "alice"), failed], known), []);
  // a newer update that went well, or a failure that is not about variants, offers nothing
  assertEquals(failedVariants([entry("applied", ""), failed], known), []);
  assertEquals(failedVariants([entry("failed", "download failed")], known), []);
  // a rebuilt entry older than the failure does not count
  assertEquals(failedVariants([failed, entry("rebuilt", "alice")], known).length, 2);
});

Deno.test("repair: the routes refuse a parameter outside the allowlist, and run nothing", async () => {
  const handle = createHandler(routes("test", new StatusCache()));
  const post = (path: string, b: unknown) =>
    handle(
      new Request(`http://127.0.0.1:7331${path}`, {
        method: "POST",
        headers: { host: "127.0.0.1:7331", "x-claude-multi": "1" },
        body: JSON.stringify(b),
      }),
    );
  for (const params of [{ profile: "no-such-profile" }, { profile: "x; id" }, { profile: "../other" }, {}]) {
    const j = await post("/api/job", { action: "desktop-rebuild", params });
    assertEquals(j.status, 400);
    assertEquals((await j.json()).ok, false);
    const a = await (await post("/api/action", { action: "desktop-rebuild", params })).json();
    assertEquals(a.code, 2);
  }
  assertEquals((await post("/api/job", { action: "doctor", params: { profile: "x" } })).status, 400);
  assertEquals((await post("/api/job", { action: "no-such-action" })).status, 400);
});
