// headless_test.ts — a node's settings and the sandbox a headless node's children start with
// (shared/mcp/lib/headless.ts), and how they reach Claude's `--settings` (providers.ts sessionSettings).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  childEnvOf,
  childSettings,
  cleanNodeConfig,
  DEFAULT_DOMAINS,
  loadNodeConfig,
  mergeNodeConfig,
  sandboxSettings,
  secretPaths,
  splitLegacy,
} from "../../../shared/mcp/lib/headless.ts";
import { sessionSettings } from "../../../shared/mcp/lib/providers.ts";

Deno.test("headless: node.json keeps what is valid, defaults the rest", () => {
  const c = cleanNodeConfig({
    enabled: true,
    headless: "yes",
    name: "atlas",
    maxSessions: 3,
    repoRoots: ["~/work", "relative", 4],
    allowedDomains: ["git.example.com", "*.npmjs.org", "evil host"],
    approvalKey: "short",
    repos: ["git@git.example.com:me/site.git", "file:///etc", 3],
  });
  assertEquals(c, {
    enabled: true,
    headless: false,
    name: "atlas",
    maxSessions: 3,
    repoRoots: ["~/work"],
    allowedDomains: ["git.example.com", "*.npmjs.org"],
    repos: ["git@git.example.com:me/site.git"],
  });
  assertEquals(cleanNodeConfig(null), {
    enabled: false,
    headless: false,
    repoRoots: ["~"],
    allowedDomains: DEFAULT_DOMAINS,
    repos: [],
  });
  assertEquals(cleanNodeConfig({ maxSessions: -1, name: "../x" }).maxSessions, undefined);
});

Deno.test("headless: the sandbox is on, fails closed, and hides the machine's secrets from commands and tools", () => {
  const secrets = secretPaths("/home/n", "/home/n/.agents-multi", ["work"]);
  for (
    const p of [
      "/home/n/vault",
      "/home/n/.ssh",
      "/home/n/.agents-multi/work/.credentials.json",
      "/home/n/.agents-multi/work/mcp-token",
    ]
  ) {
    assert(secrets.includes(p), p);
  }
  const s = sandboxSettings(secrets, ["github.com"]) as {
    sandbox: Record<string, unknown> & { filesystem: { denyRead: string[] }; network: Record<string, unknown> };
    permissions: { deny: string[] };
  };
  assertEquals([s.sandbox.enabled, s.sandbox.failIfUnavailable, s.sandbox.allowUnsandboxedCommands], [
    true,
    true,
    false,
  ]);
  assertEquals(s.sandbox.network, { allowedDomains: ["github.com"], strictAllowlist: true });
  assertEquals(s.sandbox.filesystem.denyRead, secrets);
  assert(s.permissions.deny.includes("Read(//home/n/.ssh/**)"));
  assert(s.permissions.deny.includes("Edit(//home/n/.agents-multi/work/.credentials.json)"));
});

Deno.test("headless: a child's settings are the sandbox's only on a headless node", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // this machine's file in the test's folder: never the real state's
    const machine = `${dir}/state/node.json`;
    await Deno.mkdir(`${dir}/state`);
    assertEquals(await childSettings("/home/n", "/home/n/.agents-multi", dir, machine), undefined, "no node.json");
    await Deno.writeTextFile(machine, JSON.stringify({ enabled: true }));
    assertEquals(await childSettings("/home/n", "/home/n/.agents-multi", dir, machine), undefined, "a desktop node");
    await Deno.mkdir(`${dir}/profiles/work`, { recursive: true });
    await Deno.writeTextFile(machine, JSON.stringify({ enabled: true, headless: true }));
    const s = await childSettings("/home/n", "/home/n/.agents-multi", dir, machine) as {
      sandbox: { filesystem: { denyRead: string[] } };
    };
    assert(s.sandbox.filesystem.denyRead.includes("/home/n/.agents-multi/work/.credentials.json"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("headless: --settings carries the ask rules and the sandbox together", () => {
  assertEquals(sessionSettings({}), undefined);
  assertEquals(sessionSettings({ askTools: ["mcp__x"] }), { permissions: { ask: ["mcp__x"] } });
  const both = sessionSettings({
    askTools: ["mcp__x"],
    settings: { sandbox: { enabled: true }, permissions: { deny: ["Read(//s)"] } },
  });
  assertEquals(both, { sandbox: { enabled: true }, permissions: { deny: ["Read(//s)"], ask: ["mcp__x"] } });
});

Deno.test("headless: the owner's settings and the machine's each give only their own fields", () => {
  const c = mergeNodeConfig(
    { enabled: true, headless: true, allowedDomains: ["git.example.com"], repoRoots: ["~/src"] },
    { enabled: true, headless: true, maxSessions: 2, allowedDomains: ["evil.example"] },
  );
  assertEquals([c.enabled, c.headless, c.maxSessions], [true, true, 2]);
  assertEquals(c.allowedDomains, ["git.example.com"]); // never from the machine's file
  assertEquals(mergeNodeConfig({ enabled: true }, null).enabled, false); // never from the owner's
});

Deno.test("headless: the old node.json keeps its machine part only where no Syncthing carried it", () => {
  const legacy = { enabled: true, headless: true, name: "atlas", repoRoots: ["~/src"] };
  assertEquals(splitLegacy(legacy, true), { shared: { repoRoots: ["~/src"] }, machine: {} });
  assertEquals(splitLegacy(legacy, false).machine, { enabled: true, headless: true, name: "atlas" });
});

Deno.test("headless: the old node.json is moved into the two files, once", async () => {
  const root = await Deno.makeTempDir();
  const config = `${root}/config`, machine = `${root}/state/agents-multi/node.json`;
  await Deno.mkdir(config);
  await Deno.writeTextFile(
    `${config}/node.json`,
    JSON.stringify({ enabled: true, headless: true, repoRoots: ["~/src"] }),
  );
  const c = await loadNodeConfig(config, machine);
  assertEquals([c.enabled, c.headless, c.repoRoots], [true, true, ["~/src"]]);
  assertEquals(JSON.parse(await Deno.readTextFile(`${config}/nodes.json`)), { repoRoots: ["~/src"] });
  assertEquals(JSON.parse(await Deno.readTextFile(machine)), { enabled: true, headless: true });
  assertEquals(await Deno.stat(`${config}/node.json`).then(() => true, () => false), false);
  assertEquals((await loadNodeConfig(config, machine)).headless, true); // read again from the new files
});

Deno.test("headless: a child's environment carries the scrub, and the token when there is one", () => {
  assertEquals(childEnvOf(false, "sk-ant-oat01-x"), {});
  assertEquals(childEnvOf(true, null), { AM_HEADLESS: "1" });
  assertEquals(childEnvOf(true, "sk-ant-oat01-x"), { AM_HEADLESS: "1", AM_CLAUDE_TOKEN: "sk-ant-oat01-x" });
});
