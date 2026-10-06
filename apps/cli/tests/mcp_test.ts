// Tests for mcp.ts: projecting the registry onto surfaces (profiles, _surfaces, private keys, `type`).
// The profile names come from the configuration (the tests run on apps/cli/tests/fixtures/config), never
// from a literal: a rename must not break this.
import { assertEquals } from "jsr:@std/assert@1";
import {
  permissionRules,
  placements,
  type RawRegistry,
  reach,
  reachOf,
  REGISTRY,
  type Registry,
  registryProblems,
  selectServers,
  shellQuote,
  type Target,
  targets,
  wanted,
} from "../mcp.ts";
import { desktopDir, missingIgnores, profileNames } from "../lib.ts";

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
const t = (profile: string, surface: "cli" | "desktop") =>
  ALL.find((x) => x.profile === profile && x.surface === surface)!;

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
      { service: "svc", name: "two", url: "https://two.example", profiles: [A] },
      { service: "other", name: "x", url: "https://x.example" },
    ],
  };
  const got = wanted(withAccounts, t(A, "cli")).svc;
  assertEquals(got, {
    command: "deno",
    args: ["--allow-net=one.example:8443,two.example", "s.ts"],
    env: { CLAUDE_MULTI_PROFILE: A },
  });
  // B sees no svc account: no server at all, rather than one that can only fail
  assertEquals(wanted(withAccounts, t(B, "cli")).svc, undefined);
});

Deno.test("wanted: on Desktop an account-backed server gets the session bus, which Desktop's bare env lacks", () => {
  const reg: Registry = {
    profiles: PROFILES,
    bus: "unix:path=/run/user/1000/bus",
    servers: {
      svc: { command: "deno", args: ["s.ts"], _service: "svc", _surfaces: ["cli", "desktop"] },
      plain: { command: "p", _surfaces: ["desktop"] },
    },
    accounts: [{ service: "svc", name: "one", url: "https://one.example", profiles: [A] }],
  };
  assertEquals(wanted(reg, t(A, "desktop")).svc.env, {
    CLAUDE_MULTI_PROFILE: A,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  });
  // the CLI inherits the session's env: nothing pinned there
  assertEquals(wanted(reg, t(A, "cli")).svc.env, { CLAUDE_MULTI_PROFILE: A });
  // a server that reads no secret is left as written
  assertEquals(wanted(reg, t(A, "desktop")).plain, { command: "p" });
});

Deno.test("selectServers: an implicit profile list stays implicit and still means everyone", () => {
  const raw: RawRegistry = {
    servers: { a: { command: "a" }, b: { command: "b" }, c: { command: "c", _profiles: [B] } },
  };
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

// ---------------------------------------------------------------- one server per account (_perAccount)
const LAUNCH = {
  script: "/rt/shared/mcp/lib/launch.ts",
  read: ["/vault", "/rt/accounts.json"],
  hooks: "/rt/shared/hooks",
};
const perAccountReg: Registry = {
  profiles: PROFILES,
  launch: LAUNCH,
  servers: {
    flows: {
      _service: "flows",
      type: "stdio",
      command: "npx",
      args: ["-y", "flows-mcp", "--base={url}"],
      env: { MODE: "stdio" },
      _perAccount: { env: { FLOWS_URL: "{url}", FLOWS_KEY: "{secret}" } },
      _surfaces: ["cli", "desktop"],
      _deny: ["delete_flow"],
      _ask: ["run_flow"],
    },
    remote: {
      _service: "remote",
      type: "http",
      url: "{url}",
      _perAccount: { headers: { Authorization: "Bearer {secret}" } },
      _deny: ["drop"],
      _guard: { tool: "execute", hook: "remote-guard.ts" },
    },
    oauth: { _service: "oauth", type: "http", url: "https://mcp.example/{name}", _perAccount: {} },
  },
  accounts: [
    { service: "flows", name: "mine", url: "https://flows.mine.example", profiles: [A] },
    { service: "flows", name: "work", url: "https://flows.work.example:8443", profiles: [A, B] },
    {
      service: "remote",
      name: "proj",
      url: "https://mcp.remote.example/mcp?project_ref=abc&read_only=true",
      profiles: [A],
    },
    { service: "oauth", name: "acme", auth: "oauth", profiles: [B] },
  ],
};

Deno.test("perAccount: one server per account the profile sees, named <entry>-<account>", () => {
  assertEquals(Object.keys(wanted(perAccountReg, t(A, "cli"))).sort(), ["flows-mine", "flows-work", "remote-proj"]);
  assertEquals(Object.keys(wanted(perAccountReg, t(B, "cli"))).sort(), ["flows-work", "oauth-acme"]);
});

Deno.test("reach: per account, under the names the servers have; pending, and Desktop never opened", () => {
  const reg: Registry = {
    ...perAccountReg,
    servers: { ...perAccountReg.servers, sync: { command: "s", _profiles: [A] } },
  };
  const r = reach(placements(reg), {
    [A]: { cli: ["flows-mine", "flows-work", "sync"], desktop: null },
    [B]: { cli: ["flows-work"], desktop: ["flows-work"] },
  }, true);
  // flows/mine: CLI mounted, Desktop never opened for A (not pending)
  assertEquals(r["flows/mine"], { profiles: [A], pending: [], noDesktop: [A] });
  assertEquals(r["flows/work"], { profiles: [A, B].sort(), pending: [], noDesktop: [A] });
  // remote/proj (http, CLI only) is not in A's CLI config yet: a sync away
  assertEquals(r["remote/proj"], { profiles: [A], pending: [A], noDesktop: [] });
  assertEquals(r["oauth/acme"], { profiles: [B], pending: [B], noDesktop: [] });
  // a server without accounts is keyed by its entry
  assertEquals(r["server/sync"], { profiles: [A], pending: [], noDesktop: [] });
  // no Claude Desktop on this machine: its places do not count
  assertEquals(
    reach(placements(reg), { [A]: { cli: ["flows-mine"], desktop: null } }, false)["flows/mine"].noDesktop,
    [],
  );
});

Deno.test("perAccount (stdio): launch.ts wraps the command, the secret stays a placeholder", () => {
  const s = wanted(perAccountReg, t(A, "cli"))["flows-work"];
  assertEquals(s.command, "deno");
  assertEquals(s.args, [
    "run",
    "--quiet",
    "--no-lock",
    "--allow-read=/vault,/rt/accounts.json",
    "--allow-env=HOME,CLAUDE_MULTI_PROFILE,CLAUDE_MULTI_VAULT,CLAUDE_MULTI_ACCOUNTS",
    "--allow-run=/usr/bin/secret-tool,npx",
    "/rt/shared/mcp/lib/launch.ts",
    "run",
    "flows",
    "work",
    "--env",
    "FLOWS_URL=https://flows.work.example:8443",
    "--env",
    "FLOWS_KEY={secret}",
    "--",
    "npx",
    "-y",
    "flows-mcp",
    "--base=https://flows.work.example:8443",
  ]);
  assertEquals(s.env, { MODE: "stdio", CLAUDE_MULTI_PROFILE: A });
  assertEquals(s.type, "stdio");
  // on Desktop: no `type`, and the session bus is not pinned unless the registry knows it
  assertEquals("type" in wanted(perAccountReg, t(A, "desktop"))["flows-work"], false);
});

Deno.test("perAccount (stdio, _bind): the binding keys go to launch.ts, which may then read the home folder", () => {
  const reg: Registry = {
    ...perAccountReg,
    servers: {
      flows: { ...perAccountReg.servers.flows, _bind: { project: "--project-ref={value}", readOnly: "--read-only" } },
    },
  };
  const s = wanted(reg, t(A, "cli"))["flows-work"];
  const args = s.args as string[];
  assertEquals(args[3], `--allow-read=/vault,/rt/accounts.json,${Deno.env.get("HOME")}`);
  assertEquals(args.slice(args.indexOf("--bind"), args.indexOf("--")), [
    "--bind",
    "project=--project-ref={value}",
    "--bind",
    "readOnly=--read-only",
  ]);
  assertEquals(
    registryProblems({ ...reg, servers: { r: { ...perAccountReg.servers.remote, _bind: { project: "x" } } } })[0],
    "r: _bind needs a stdio server started through launch.ts (_perAccount.env)",
  );
});

Deno.test("perAccount (http): headers come from a headersHelper, never written; http stays off Desktop", () => {
  const s = wanted(perAccountReg, t(A, "cli"))["remote-proj"];
  assertEquals(s.url, "https://mcp.remote.example/mcp?project_ref=abc&read_only=true");
  assertEquals(
    s.headersHelper,
    `CLAUDE_MULTI_PROFILE=${A} deno run --quiet --no-lock --allow-read=/vault,/rt/accounts.json ` +
      "--allow-env=HOME,CLAUDE_MULTI_PROFILE,CLAUDE_MULTI_VAULT,CLAUDE_MULTI_ACCOUNTS --allow-run=/usr/bin/secret-tool " +
      "/rt/shared/mcp/lib/launch.ts headers remote proj 'Authorization=Bearer {secret}'",
  );
  assertEquals("env" in s, false);
  // an OAuth server: one per account, nothing to fill in
  assertEquals(wanted(perAccountReg, t(B, "cli"))["oauth-acme"], { type: "http", url: "https://mcp.example/acme" });
  assertEquals(Object.keys(wanted(perAccountReg, t(B, "desktop"))), ["flows-work"]);
});

Deno.test("permissionRules: _deny and _ask under each server's name, only where the profile gets it", () => {
  assertEquals(permissionRules(perAccountReg, A), {
    deny: ["mcp__flows-mine__delete_flow", "mcp__flows-work__delete_flow", "mcp__remote-proj__drop"],
    ask: ["mcp__flows-mine__run_flow", "mcp__flows-work__run_flow"],
    hooks: [{
      matcher: "^(mcp__remote-proj__execute)$",
      hooks: [{ type: "command", command: "deno run --quiet --no-lock /rt/shared/hooks/remote-guard.ts" }],
    }],
  });
  assertEquals(permissionRules(perAccountReg, B), {
    deny: ["mcp__flows-work__delete_flow"],
    ask: ["mcp__flows-work__run_flow"],
    hooks: [],
  });
  // a plain server's rules use its own name
  assertEquals(permissionRules({ profiles: PROFILES, servers: { s: { command: "s", _deny: ["x"] } } }, A), {
    deny: ["mcp__s__x"],
    ask: [],
    hooks: [],
  });
  // the guard's matcher matches its servers and nothing else
  const m = new RegExp(permissionRules(perAccountReg, A).hooks[0].matcher);
  assertEquals([
    m.test("mcp__remote-proj__execute"),
    m.test("mcp__remote-proj__search"),
    m.test("mcp__remote-projx__execute"),
  ], [true, false, false]);
});

Deno.test("registryProblems: {secret} outside _perAccount, missing _service, wrong template kind, http on Desktop", () => {
  assertEquals(registryProblems(perAccountReg), []);
  const bad = registryProblems({
    servers: {
      leak: { command: "x", env: { K: "{secret}" } },
      orphan: { command: "x", _perAccount: { env: { K: "{secret}" } } },
      mixed: {
        _service: "s",
        type: "http",
        url: "u",
        _perAccount: { env: { K: "{secret}" } },
        _surfaces: ["cli", "desktop"],
      },
    },
  });
  assertEquals(bad.length, 4);
  assertEquals(bad.map((p) => p.split(":")[0]), ["leak", "orphan", "mixed", "mixed"]);
});

Deno.test("shellQuote: plain words stay bare, the rest is single-quoted safely", () => {
  assertEquals(shellQuote("--allow-read=/a,/b"), "--allow-read=/a,/b");
  assertEquals(shellQuote("Authorization=Bearer {secret}"), "'Authorization=Bearer {secret}'");
  assertEquals(shellQuote("it's"), `'it'\\''s'`);
});

Deno.test("wanted: a remote account-backed server is at its one account's address, nobody's written in", () => {
  const r: Registry = {
    profiles: PROFILES,
    servers: { brain: { type: "http", url: "{url}/mcp", _service: "brain" } },
    accounts: [{ service: "brain", name: "brain", url: "https://brain-ann.example" }],
  };
  assertEquals(wanted(r, t(A, "cli")).brain, { type: "http", url: "https://brain-ann.example/mcp" });
  // two brains for one profile: which one would it be? none, rather than a guess
  const two = { ...r, accounts: [...r.accounts!, { service: "brain", name: "b2", url: "https://b2.example" }] };
  assertEquals(wanted(two, t(A, "cli")).brain, undefined);
});

Deno.test("reachOf: a template turned on by nobody reaches no profile, so health skips it", () => {
  const r: Registry = { profiles: PROFILES, servers: {}, accounts: [{ service: "svc", name: "one", profiles: [A] }] };
  assertEquals(reachOf(r, { command: "x", _profiles: [] }), []);
  assertEquals(reachOf(r, { command: "x", _service: "other" }), []);
  assertEquals(reachOf(r, { command: "x", _service: "svc" }), [A]);
  assertEquals(reachOf(r, { command: "x" }), PROFILES);
});

Deno.test("catalogue: shared/mcp/servers.json turns nothing on for someone with no accounts and no choices", async () => {
  const catalogue = JSON.parse(await Deno.readTextFile(REGISTRY)) as RawRegistry;
  const fresh: Registry = { profiles: PROFILES, servers: catalogue.servers, accounts: [] };
  for (const [name, cfg] of Object.entries(catalogue.servers)) {
    assertEquals(reachOf(fresh, cfg), [], `${name} is on for everyone: give it _service or "_profiles": []`);
  }
});

Deno.test("missingIgnores: the patterns a global ignore file does not list yet, whole lines only", () => {
  const want = ["**/.claude/claude-multi.json"];
  assertEquals(missingIgnores("", want), want);
  assertEquals(missingIgnores("**/.claude/settings.local.json\n**/.claude/claude-multi.json\n", want), []);
  assertEquals(missingIgnores("# **/.claude/claude-multi.json\n", want), want);
});
