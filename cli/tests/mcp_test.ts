// Tests for mcp.ts: projecting the registry onto surfaces (profiles, _surfaces, private keys, `type`).
import { assertEquals } from "jsr:@std/assert@1";
import { type Registry, type Target, targets, wanted } from "../mcp.ts";

const reg: Registry = {
  profiles: ["personal", "work"],
  servers: {
    everywhere: { type: "stdio", command: "x", args: ["a"], env: { K: "v" }, _note: "ignored" },
    onlyPersonal: { type: "stdio", command: "y", _profiles: ["personal"] },
    chatToo: { type: "stdio", command: "z", _surfaces: ["cli", "desktop"] },
    desktopOnly: { command: "w", _surfaces: ["desktop"], _profiles: ["work"] },
  },
};

// targets() reads the repo, so it is resolved once and the tests index into the result.
const ALL: Target[] = await targets();
const t = (profile: string, surface: "cli" | "desktop") => ALL.find((x) => x.profile === profile && x.surface === surface)!;

Deno.test("targets: one cli and one desktop entry per profile, with path and managed key", () => {
  assertEquals(ALL.length, 4);
  assertEquals(ALL.map((x) => x.managedKey).sort(), ["cli:personal", "cli:work", "desktop:personal", "desktop:work"]);
  assertEquals(t("work", "desktop").path.endsWith("/Claude-Work/claude_desktop_config.json"), true);
  assertEquals(t("personal", "cli").path.endsWith("/personal/.claude.json"), true);
});

Deno.test("wanted: defaults to every profile on cli only; _profiles and _surfaces narrow it", () => {
  assertEquals(Object.keys(wanted(reg, t("personal", "cli"))).sort(), ["chatToo", "everywhere", "onlyPersonal"]);
  assertEquals(Object.keys(wanted(reg, t("work", "cli"))).sort(), ["chatToo", "everywhere"]);
  assertEquals(Object.keys(wanted(reg, t("personal", "desktop"))), ["chatToo"]);
  assertEquals(Object.keys(wanted(reg, t("work", "desktop"))).sort(), ["chatToo", "desktopOnly"]);
});

Deno.test("wanted: _private keys are stripped, and `type` is dropped on the desktop surface", () => {
  const cli = wanted(reg, t("personal", "cli")).everywhere;
  assertEquals(cli, { type: "stdio", command: "x", args: ["a"], env: { K: "v" } });
  const desk = wanted(reg, t("personal", "desktop")).chatToo;
  assertEquals(desk, { command: "z" });
});
