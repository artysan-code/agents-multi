// headless_test.ts — a node's settings and the sandbox a headless node's children start with
// (shared/mcp/lib/headless.ts), and how they reach Claude's `--settings` (providers.ts sessionSettings).
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  childSettings,
  cleanNodeConfig,
  DEFAULT_DOMAINS,
  sandboxSettings,
  secretPaths,
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
  });
  assertEquals(c, {
    enabled: true,
    headless: false,
    name: "atlas",
    maxSessions: 3,
    repoRoots: ["~/work"],
    allowedDomains: ["git.example.com", "*.npmjs.org"],
  });
  assertEquals(cleanNodeConfig(null), {
    enabled: false,
    headless: false,
    repoRoots: ["~"],
    allowedDomains: DEFAULT_DOMAINS,
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
    assertEquals(await childSettings("/home/n", "/home/n/.agents-multi", dir), undefined, "no node.json");
    await Deno.writeTextFile(`${dir}/node.json`, JSON.stringify({ enabled: true }));
    assertEquals(await childSettings("/home/n", "/home/n/.agents-multi", dir), undefined, "a desktop node");
    await Deno.mkdir(`${dir}/profiles/work`, { recursive: true });
    await Deno.writeTextFile(`${dir}/node.json`, JSON.stringify({ enabled: true, headless: true }));
    const s = await childSettings("/home/n", "/home/n/.agents-multi", dir) as {
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
