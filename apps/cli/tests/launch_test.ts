// Tests for shared/mcp/lib/launch.ts: the command line it takes, where the secret goes, and how a
// project ties a server to itself.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  bindArgs,
  bindingDirs,
  envRecords,
  fill,
  findBinding,
  parseLaunchArgs,
} from "../../../shared/mcp/lib/launch.ts";

Deno.test("parseLaunchArgs: env takes --env and --bind pairs, then the command after --", () => {
  assertEquals(
    parseLaunchArgs([
      "env",
      "n8n",
      "main",
      "--env",
      "URL=https://x",
      "--env",
      "KEY={secret}",
      "--",
      "npx",
      "-y",
      "n8n-mcp",
      "--env",
      "kept",
    ]),
    {
      mode: "env",
      service: "n8n",
      account: "main",
      vars: { URL: "https://x", KEY: "{secret}" },
      binds: {},
      command: "npx",
      args: ["-y", "n8n-mcp", "--env", "kept"],
    },
  );
  // a value may hold "=" itself
  assertEquals(parseLaunchArgs(["env", "s", "a", "--env", "Q=a=b", "--", "c"]).vars, { Q: "a=b" });
  assertEquals(
    parseLaunchArgs([
      "env",
      "s",
      "a",
      "--env",
      "K={secret}",
      "--bind",
      "project=--project-ref={value}",
      "--bind",
      "readOnly=--read-only",
      "--",
      "c",
    ]).binds,
    { project: "--project-ref={value}", readOnly: "--read-only" },
  );
});

Deno.test("parseLaunchArgs: headers takes NAME=template pairs", () => {
  assertEquals(parseLaunchArgs(["headers", "supabase", "client", "Authorization=Bearer {secret}"]), {
    mode: "headers",
    service: "supabase",
    account: "client",
    vars: { Authorization: "Bearer {secret}" },
    binds: {},
    args: [],
  });
});

Deno.test("parseLaunchArgs: refuses what it cannot read", () => {
  assertThrows(() => parseLaunchArgs(["exec", "s", "a"]));
  assertThrows(() => parseLaunchArgs(["run", "s", "a", "--", "c"])); // the old mode is gone
  assertThrows(() => parseLaunchArgs(["env", "s"]));
  assertThrows(() => parseLaunchArgs(["env", "s", "a", "--env", "K=v"]), Error, "after --");
  assertThrows(() => parseLaunchArgs(["env", "s", "a", "stray", "--", "c"]));
  assertThrows(() => parseLaunchArgs(["env", "s", "a", "--bind", "=x", "--", "c"]));
  // a variable name is what the shell exports: nothing else gets into launch.sh's records
  assertThrows(() => parseLaunchArgs(["env", "s", "a", "--env", "A-B=v", "--", "c"]), Error, "variable name");
  assertThrows(() => parseLaunchArgs(["headers", "s", "a", "=nokey"]));
});

Deno.test("envRecords: NUL-ended, E for a variable and A for an argument, the value as it is", () => {
  assertEquals(
    envRecords({ K: "s e;cr'et\n$(x)", U: "https://x" }, ["--project-ref=abc", "--read-only"]),
    [
      "EK=s e;cr'et\n$(x)",
      "EU=https://x",
      "A--project-ref=abc",
      "A--read-only",
    ].map((r) => `${r}\0`).join(""),
  );
  assertEquals(envRecords({}, []), "");
});

Deno.test("fill: {secret} replaced everywhere it appears, the rest untouched", () => {
  assertEquals(fill({ A: "Bearer {secret}", B: "{secret}:{secret}", C: "plain" }, "s3"), {
    A: "Bearer s3",
    B: "s3:s3",
    C: "plain",
  });
});

const BINDS = { project: "--project-ref={value}", readOnly: "--read-only" };

Deno.test("bindArgs: the keys a project set for this service, in the server's order; nothing else", () => {
  assertEquals(bindArgs({ supabase: { project: "fmgshdbrtdxxvqioxwbb", readOnly: false } }, "supabase", BINDS), [
    "--project-ref=fmgshdbrtdxxvqioxwbb",
  ]);
  assertEquals(bindArgs({ supabase: { readOnly: true, project: "abc" } }, "supabase", BINDS), [
    "--project-ref=abc",
    "--read-only",
  ]);
  assertEquals(bindArgs({ supabase: { project: "abc", other: "x" } }, "supabase", BINDS), ["--project-ref=abc"]);
  assertEquals(bindArgs({ n8n: { project: "abc" } }, "supabase", BINDS), []); // another service's section
  assertEquals(bindArgs(null, "supabase", BINDS), []);
  // a value lands on a command line: a plain word only
  assertThrows(
    () => bindArgs({ supabase: { project: "abc --access-token=x" } }, "supabase", BINDS),
    Error,
    "plain word",
  );
  assertThrows(() => bindArgs({ supabase: { project: 42 } }, "supabase", BINDS), Error, "plain word");
});

Deno.test("bindingDirs: from the folder up to home, nearest first; nothing outside home", () => {
  assertEquals(bindingDirs("/home/u/work/a/repo", "/home/u"), [
    "/home/u/work/a/repo",
    "/home/u/work/a",
    "/home/u/work",
    "/home/u",
  ]);
  assertEquals(bindingDirs("/home/u", "/home/u/"), ["/home/u"]);
  assertEquals(bindingDirs("/home/uu/x", "/home/u"), []);
  assertEquals(bindingDirs("/tmp/x", "/home/u"), []);
});

Deno.test("findBinding: the nearest file up the tree wins; a broken one says where it is", () => {
  const home = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(`${home}/proj/.claude`, { recursive: true });
    Deno.mkdirSync(`${home}/proj/repo/src`, { recursive: true });
    Deno.writeTextFileSync(`${home}/proj/.claude/claude-multi.json`, JSON.stringify({ supabase: { project: "abc" } }));
    assertEquals(findBinding(`${home}/proj/repo/src`, home), {
      path: `${home}/proj/.claude/claude-multi.json`,
      binding: { supabase: { project: "abc" } },
    });
    assertEquals(findBinding(home, home), null);
    Deno.mkdirSync(`${home}/proj/repo/.claude`);
    Deno.writeTextFileSync(`${home}/proj/repo/.claude/claude-multi.json`, "{ not json");
    assertThrows(
      () => findBinding(`${home}/proj/repo/src`, home),
      Error,
      `${home}/proj/repo/.claude/claude-multi.json`,
    );
  } finally {
    Deno.removeSync(home, { recursive: true });
  }
});
