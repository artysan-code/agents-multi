// Tests for shared/mcp/lib/launch.ts: the command line it takes, and where the secret goes.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { fill, parseLaunchArgs } from "../../shared/mcp/lib/launch.ts";

Deno.test("parseLaunchArgs: run takes --env pairs, then the command after --", () => {
  assertEquals(parseLaunchArgs(["run", "n8n", "ark", "--env", "URL=https://x", "--env", "KEY={secret}", "--", "npx", "-y", "n8n-mcp", "--env", "kept"]), {
    mode: "run", service: "n8n", account: "ark", vars: { URL: "https://x", KEY: "{secret}" }, command: "npx", args: ["-y", "n8n-mcp", "--env", "kept"],
  });
  // a value may hold "=" itself
  assertEquals(parseLaunchArgs(["run", "s", "a", "--env", "Q=a=b", "--", "c"]).vars, { Q: "a=b" });
});

Deno.test("parseLaunchArgs: headers takes NAME=template pairs", () => {
  assertEquals(parseLaunchArgs(["headers", "supabase", "client", "Authorization=Bearer {secret}"]), {
    mode: "headers", service: "supabase", account: "client", vars: { Authorization: "Bearer {secret}" }, args: [],
  });
});

Deno.test("parseLaunchArgs: refuses what it cannot read", () => {
  assertThrows(() => parseLaunchArgs(["exec", "s", "a"]));
  assertThrows(() => parseLaunchArgs(["run", "s"]));
  assertThrows(() => parseLaunchArgs(["run", "s", "a", "--env", "K=v"]), Error, "after --");
  assertThrows(() => parseLaunchArgs(["run", "s", "a", "stray", "--", "c"]));
  assertThrows(() => parseLaunchArgs(["headers", "s", "a", "=nokey"]));
});

Deno.test("fill: {secret} replaced everywhere it appears, the rest untouched", () => {
  assertEquals(fill({ A: "Bearer {secret}", B: "{secret}:{secret}", C: "plain" }, "s3"), { A: "Bearer s3", B: "s3:s3", C: "plain" });
});
