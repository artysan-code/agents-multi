// Test di mcp.ts: proiezione del registry sulle superfici (profili, _surfaces, chiavi private, `type`).
import { assertEquals } from "jsr:@std/assert@1";
import { type Registry, targets, wanted } from "../mcp.ts";

const reg: Registry = {
  profiles: ["personal", "work"],
  servers: {
    everywhere: { type: "stdio", command: "x", args: ["a"], env: { K: "v" }, _note: "ignorata" },
    onlyPersonal: { type: "stdio", command: "y", _profiles: ["personal"] },
    chatToo: { type: "stdio", command: "z", _surfaces: ["cli", "desktop"] },
    desktopOnly: { command: "w", _surfaces: ["desktop"], _profiles: ["work"] },
  },
};
const t = (profile: "personal" | "work", surface: "cli" | "desktop") => targets().find((x) => x.profile === profile && x.surface === surface)!;

Deno.test("targets: 2 profili × 2 superfici, path e chiave gestita", () => {
  const all = targets();
  assertEquals(all.length, 4);
  assertEquals(all.map((x) => x.managedKey).sort(), ["cli:personal", "cli:work", "desktop:personal", "desktop:work"]);
  assertEquals(t("work", "desktop").path.endsWith("/Claude-Work/claude_desktop_config.json"), true);
  assertEquals(t("personal", "cli").path.endsWith("/personal/.claude.json"), true);
});

Deno.test("wanted: default = tutti i profili, solo cli; _profiles e _surfaces filtrano", () => {
  assertEquals(Object.keys(wanted(reg, t("personal", "cli"))).sort(), ["chatToo", "everywhere", "onlyPersonal"]);
  assertEquals(Object.keys(wanted(reg, t("work", "cli"))).sort(), ["chatToo", "everywhere"]);
  assertEquals(Object.keys(wanted(reg, t("personal", "desktop"))), ["chatToo"]);
  assertEquals(Object.keys(wanted(reg, t("work", "desktop"))).sort(), ["chatToo", "desktopOnly"]);
});

Deno.test("wanted: le chiavi _private non passano; sul desktop cade `type`", () => {
  const cli = wanted(reg, t("personal", "cli")).everywhere;
  assertEquals(cli, { type: "stdio", command: "x", args: ["a"], env: { K: "v" } });
  const desk = wanted(reg, t("personal", "desktop")).chatToo;
  assertEquals(desk, { command: "z" });
});
