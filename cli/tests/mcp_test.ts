// Tests for mcp.ts: projecting the registry onto surfaces (profiles, _surfaces, private keys, `type`).
// The profile names come from the repository, never from a literal: a rename must not break this.
import { assertEquals } from "jsr:@std/assert@1";
import { type RawRegistry, type Registry, selectServers, type Target, targets, wanted } from "../mcp.ts";
import { desktopDir, profileNames } from "../lib.ts";

const PROFILES = await profileNames();
// One profile to single out, one to contrast it with. Which two does not matter.
const [A, B] = PROFILES;

const reg: Registry = {
  profiles: PROFILES,
  servers: {
    everywhere: { type: "stdio", command: "x", args: ["a"], env: { K: "v" }, _note: "ignored" },
    onlyA: { type: "stdio", command: "y", _profiles: [A] },
    chatToo: { type: "stdio", command: "z", _surfaces: ["cli", "desktop"] },
    desktopOnlyB: { command: "w", _surfaces: ["desktop"], _profiles: [B] },
  },
};

// targets() reads the repo, so it is resolved once and the tests index into the result.
const ALL: Target[] = await targets();
const t = (profile: string, surface: "cli" | "desktop") => ALL.find((x) => x.profile === profile && x.surface === surface)!;

Deno.test("targets: one cli and one desktop entry per profile, with path and managed key", async () => {
  assertEquals(ALL.length, PROFILES.length * 2);
  assertEquals(
    ALL.map((x) => x.managedKey).sort(),
    PROFILES.flatMap((p) => [`cli:${p}`, `desktop:${p}`]).sort(),
  );
  for (const p of PROFILES) {
    assertEquals(t(p, "cli").path.endsWith(`/${p}/.claude.json`), true, `${p}: cli path`);
    // The desktop target has to land in that profile's own data dir, whatever the manifest says.
    assertEquals(t(p, "desktop").path, `${await desktopDir(p)}/claude_desktop_config.json`);
  }
});

Deno.test("wanted: defaults to every profile on cli only; _profiles and _surfaces narrow it", () => {
  assertEquals(Object.keys(wanted(reg, t(A, "cli"))).sort(), ["chatToo", "everywhere", "onlyA"]);
  assertEquals(Object.keys(wanted(reg, t(B, "cli"))).sort(), ["chatToo", "everywhere"]);
  assertEquals(Object.keys(wanted(reg, t(A, "desktop"))), ["chatToo"]);
  assertEquals(Object.keys(wanted(reg, t(B, "desktop"))).sort(), ["chatToo", "desktopOnlyB"]);
});

Deno.test("wanted: _private keys are stripped, and `type` is dropped on the desktop surface", () => {
  const cli = wanted(reg, t(A, "cli")).everywhere;
  assertEquals(cli, { type: "stdio", command: "x", args: ["a"], env: { K: "v" } });
  const desk = wanted(reg, t(A, "desktop")).chatToo;
  assertEquals(desk, { command: "z" });
});

Deno.test("wanted: an account-backed server goes only where an account is visible, with its hosts and profile", () => {
  const withAccounts: Registry = {
    profiles: PROFILES,
    servers: { svc: { command: "deno", args: ["--allow-net={hosts}", "s.ts"], _service: "svc" } },
    accounts: [
      { service: "svc", name: "one", url: "https://one.example:8443/api", profiles: [A] },
      { service: "svc", name: "two", url: "https://two.example" , profiles: [A] },
      { service: "other", name: "x", url: "https://x.example" },
    ],
  };
  const got = wanted(withAccounts, t(A, "cli")).svc;
  assertEquals(got, { command: "deno", args: ["--allow-net=one.example:8443,two.example", "s.ts"], env: { CLAUDE_MULTI_PROFILE: A } });
  // B sees no svc account: no server at all, rather than one that can only fail
  assertEquals(wanted(withAccounts, t(B, "cli")).svc, undefined);
});

Deno.test("wanted: on Desktop an account-backed server gets the session bus, which Desktop's bare env lacks", () => {
  const reg: Registry = {
    profiles: PROFILES, bus: "unix:path=/run/user/1000/bus",
    servers: { svc: { command: "deno", args: ["s.ts"], _service: "svc", _surfaces: ["cli", "desktop"] }, plain: { command: "p", _surfaces: ["desktop"] } },
    accounts: [{ service: "svc", name: "one", url: "https://one.example", profiles: [A] }],
  };
  assertEquals(wanted(reg, t(A, "desktop")).svc.env, { CLAUDE_MULTI_PROFILE: A, DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" });
  // the CLI inherits the session's env: nothing pinned there
  assertEquals(wanted(reg, t(A, "cli")).svc.env, { CLAUDE_MULTI_PROFILE: A });
  // a server that reads no secret is left as written
  assertEquals(wanted(reg, t(A, "desktop")).plain, { command: "p" });
});

Deno.test("selectServers: an implicit profile list stays implicit and still means everyone", () => {
  const raw: RawRegistry = { servers: { a: { command: "a" }, b: { command: "b" }, c: { command: "c", _profiles: [B] } } };
  // A drops b and picks c: b gains an explicit list without A, c gains A, the top level stays absent
  const next = selectServers(raw, PROFILES, A, ["a", "c"]);
  assertEquals("profiles" in next, false);
  assertEquals(next.servers.a._profiles, undefined);
  assertEquals(next.servers.b._profiles, PROFILES.filter((p) => p !== A).sort());
  const ab = [A, B].sort();
  assertEquals(next.servers.c._profiles, ab.length === PROFILES.length ? undefined : ab);
  // picking b again folds it back to the implicit form
  assertEquals(selectServers(next, PROFILES, A, ["a", "b", "c"]).servers.b._profiles, undefined);
  // the input is not mutated
  assertEquals(raw.servers.c._profiles, [B]);
});

Deno.test("selectServers: an explicit profile list gains a new profile", () => {
  const next = selectServers({ profiles: [A], servers: { a: { command: "a" } } }, PROFILES, B, ["a"]);
  assertEquals(next.profiles, [A, B].sort());
  assertEquals(next.servers.a._profiles, undefined);
});
