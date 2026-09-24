// Tests for pluginRecordState: which install records the doctor fails on, and which it only warns about.
import { assertEquals } from "jsr:@std/assert@1";
import { pluginRecordState } from "../lib.ts";

Deno.test("pluginRecordState: a missing cache is broken, a missing project is stale, never both", () => {
  const present = new Set(["/cache/ok", "/proj/here"]);
  const r = pluginRecordState({
    "ok@m": [{ scope: "user", installPath: "/cache/ok" }],
    "gone@m": [{ scope: "user", installPath: "/cache/gone" }, { scope: "local", projectPath: "/proj/here", installPath: "/cache/gone" }],
    "moved@m": [{ scope: "project", projectPath: "/proj/moved", installPath: "/cache/gone" }],
    "nopath@m": [{ scope: "user" }],
    "odd@m": "not a list",
  }, (p) => present.has(p));
  assertEquals(r.broken, ["gone@m"]);
  assertEquals(r.stale, [{ id: "moved@m", scope: "project", project: "/proj/moved" }]);
});

Deno.test("pluginRecordState: a user record never goes stale, whatever projectPath says", () => {
  const r = pluginRecordState({ "u@m": [{ scope: "user", projectPath: "/proj/gone", installPath: "/cache/ok" }] }, (p) => p === "/cache/ok");
  assertEquals(r, { broken: [], stale: [] });
});
