// node_seed_test.ts — `agents node seed` (apps/cli/node/seed.ts, ADR 0014 slice A): which ignored files are seeded
// and which never are, the caps, the entry and what a machine reads of it, the doctor's findings; and, hermetic in
// a temp repository with a git of no global configuration, what is collected and how a node writes it back.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  applySeedFiles,
  capFiles,
  collectSeed,
  filesFor,
  hasClaudeKey,
  parseSeedArgs,
  parseSeedEntry,
  SEED_CAP,
  type SeedEntry,
  seedEntry,
  seedFindings,
  seedRefusal,
  textOf,
} from "../node/seed.ts";

Deno.test("seed: only env files, near the root, never under a build or tool folder, never a key", () => {
  for (const p of [".env", ".env.local", "apps/web/.dev.vars", "a/b/c/.env.production", ".dev.vars.staging"]) {
    assertEquals(seedRefusal(p), null, p);
  }
  assertEquals(seedRefusal(".envrc"), "not an env file");
  assertEquals(seedRefusal("config.env"), "not an env file");
  assertEquals(seedRefusal("a/b/c/d/.env"), "more than three folders down");
  assertEquals(seedRefusal("node_modules/x/.env"), "under node_modules/");
  assertEquals(seedRefusal("vendor/.env"), "under vendor/");
  assertEquals(seedRefusal("dist/.env"), "under dist/");
  assertEquals(seedRefusal(".claude/.env"), "under .claude/");
  assertEquals(seedRefusal(".agents/runs/.env"), "under .agents/");
  assertEquals(seedRefusal(".env.pem"), "a key or credentials file");
  assertEquals(seedRefusal(".env.key"), "a key or credentials file");
  assertEquals(seedRefusal(".env.p12"), "a key or credentials file");
  assertEquals(seedRefusal("../.env"), "not a path in it");
  assertEquals(seedRefusal("/etc/.env"), "not a path in it");
  assertEquals(seedRefusal("a//.env"), "not a path in it");
});

Deno.test("seed: text only, and never a Claude key", () => {
  assertEquals(textOf(new TextEncoder().encode("A=1\n")), "A=1\n");
  assertEquals(textOf(new Uint8Array([0xff, 0xfe, 0x00])), null);
  assertEquals(textOf(new TextEncoder().encode("A=\0")), null);
  assert(hasClaudeKey("ANTHROPIC_API_KEY=sk-ant-api03-abcdefghij"));
  assert(!hasClaudeKey("OPENAI_API_KEY=sk-abc"));
});

Deno.test("seed: over a cap is skipped with its name, never cut", () => {
  const f = (path: string, size: number) => ({ path, size });
  const r = capFiles([f("b/.env", 10), f(".env", SEED_CAP.file + 1), f("a/.env", 100)]);
  assertEquals(r.kept.map((x) => x.path), ["a/.env", "b/.env"]);
  assertEquals(r.skipped, [{ path: ".env", why: "over 64 KiB" }]);
  const many = Array.from({ length: 22 }, (_, i) => f(`d${String(i).padStart(2, "0")}/.env`, 1));
  assertEquals(capFiles(many).kept.length, 20);
  assertEquals(capFiles(many).skipped.length, 2);
  const big = Array.from({ length: 5 }, (_, i) => f(`d${i}/.env`, 60 * 1024));
  const rb = capFiles(big);
  assertEquals(rb.kept.length, 4);
  assertEquals(rb.skipped, [{ path: "d4/.env", why: "over 256 KiB" }]);
});

Deno.test("seed: the entry keeps earlier machines, replaces files, and a machine reads only its own", () => {
  const files = [{ path: ".env", mode: 0o600, b64: btoa("A=1\n") }];
  const first = seedEntry({ at: "2026-10-16T10:00:00Z", from: "desk", machine: "atlas", client: false, files }, null);
  assertEquals(first, { v: 1, at: "2026-10-16T10:00:00Z", from: "desk", nodes: ["atlas"], files });
  const second = seedEntry(
    { at: "2026-10-17T10:00:00Z", from: "desk", machine: "ark", client: true, files: [] },
    first,
  );
  assertEquals(second.nodes, ["ark", "atlas"]);
  assertEquals(second.files, []);
  assertEquals(second.client, true);
  const back = parseSeedEntry(JSON.stringify(first))!;
  assertEquals(back, first);
  assertEquals(filesFor(back, "atlas"), files);
  assertEquals(filesFor(back, "ark"), []);
  // what is not valid is dropped, never trusted
  assertEquals(parseSeedEntry("not json"), null);
  assertEquals(parseSeedEntry({ v: 2, at: "", nodes: [], files: [] }), null);
  const odd = parseSeedEntry({
    v: 1,
    at: "x",
    nodes: ["atlas", "../x", 3],
    files: [{ path: "../.ssh/id_ed25519", b64: "" }, { path: ".env", b64: "QQ==", mode: 0o4755 }],
  })!;
  assertEquals(odd.nodes, ["atlas"]);
  assertEquals(odd.files, [{ path: ".env", mode: 0o755, b64: "QQ==" }]);
});

Deno.test("seed: the doctor raises unknown machines and old client entries", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  const e = (nodes: string[], at: string, client?: true): SeedEntry => ({
    v: 1,
    at,
    from: "desk",
    nodes,
    ...(client ? { client } : {}),
    files: [],
  });
  assertEquals(seedFindings([], ["atlas"], now), []);
  assertEquals(seedFindings([{ account: "h/o/r", entry: e(["atlas"], "2026-10-01T00:00:00Z") }], ["atlas"], now), [
    { status: "ok", msg: "1 seeded repositories" },
  ]);
  const bad = seedFindings(
    [
      { account: "h/o/r", entry: e(["atlas", "gone"], "2026-10-01T00:00:00Z") },
      { account: "h/c/app", entry: e(["atlas"], "2026-06-01T00:00:00Z", true) },
    ],
    ["atlas"],
    now,
  );
  assertEquals(bad.map((f) => f.status), ["warn", "warn"]);
  assertStringIncludes(bad[0].msg, "gone");
  assertStringIncludes(bad[1].msg, "client's");
  // the service not reached: machines are not checked
  assertEquals(
    seedFindings([{ account: "h/o/r", entry: e(["gone"], "2026-10-01T00:00:00Z") }], null, now)[0].status,
    "ok",
  );
});

Deno.test("seed: the command's arguments", () => {
  assertEquals(parseSeedArgs(["atlas"]), { machine: "atlas", repos: [], dryRun: false });
  assertEquals(parseSeedArgs(["atlas", "--repo", "~/c/app", "--repo", "/x", "--dry-run"]), {
    machine: "atlas",
    repos: ["~/c/app", "/x"],
    dryRun: true,
  });
  assertEquals(parseSeedArgs(["--forget", "git.example.me/o/r"]), {
    repos: [],
    dryRun: false,
    forget: "git.example.me/o/r",
  });
  assert("error" in parseSeedArgs([]));
  assert("error" in parseSeedArgs(["atlas", "ark"]));
  assert("error" in parseSeedArgs(["../x"]));
  assert("error" in parseSeedArgs(["atlas", "--repo"]));
  assert("error" in parseSeedArgs(["atlas", "--forget", "x"]));
  assert("error" in parseSeedArgs(["atlas", "--yes"]));
});

async function git(cwd: string, args: string[]) {
  const r = await new Deno.Command("git", { args, cwd, stdout: "null", stderr: "null" }).output();
  return r.success;
}

/** A git with no global or system configuration (a hook running the gate sets GIT_DIR and the like: cleared). */
async function hermetic<T>(home: string, f: () => Promise<T>): Promise<T> {
  const env: Record<string, string> = {
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const ambient = Object.keys(Deno.env.toObject()).filter((k) => k.startsWith("GIT_") && !(k in env));
  const saved = Object.fromEntries([...Object.keys(env), ...ambient].map((k) => [k, Deno.env.get(k)]));
  for (const k of ambient) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    return await f();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
}

Deno.test("seed: collected from a repository, written back into another clone only where it belongs", async () => {
  const home = await Deno.realPath(await Deno.makeTempDir({ prefix: "am-seed-" }));
  try {
    await hermetic(home, async () => {
      const repo = `${home}/repo`;
      const w = (p: string, s: string | Uint8Array) => {
        Deno.mkdirSync(`${repo}/${p}`.replace(/\/[^/]+$/, ""), { recursive: true });
        typeof s === "string" ? Deno.writeTextFileSync(`${repo}/${p}`, s) : Deno.writeFileSync(`${repo}/${p}`, s);
      };
      await Deno.mkdir(repo);
      assert(await git(repo, ["init", "--quiet", "-b", "dev"]));
      w(".gitignore", ".env\n.env.*\n!.env.example\n.dev.vars\nnode_modules/\n");
      w(".env.example", "A=\n");
      assert(await git(repo, ["add", "."]));
      assert(await git(repo, ["commit", "--quiet", "-m", "first"]));
      w(".env", "A=1\n");
      w("apps/web/.dev.vars", "B=2\n");
      w("node_modules/x/.env", "N=1\n");
      w("a/b/c/d/.env", "D=1\n");
      w(".env.pem", "-----BEGIN-----\n");
      w(".env.bin", new Uint8Array([0xff, 0x00, 0xfe]));
      w(".env.claude", "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijk\n");
      w(".env.big", "x".repeat(SEED_CAP.file + 1));
      await Deno.writeTextFile(`${home}/outside`, "O=1\n");
      await Deno.symlink(`${home}/outside`, `${repo}/.env.link`);

      const { files, skipped } = await collectSeed(repo, { never: [] });
      assertEquals(files.map((f) => f.path), [".env", "apps/web/.dev.vars"]);
      const why = Object.fromEntries(skipped.map((s) => [s.path, s.why]));
      assertEquals(why[".env.pem"], "a key or credentials file");
      assertEquals(why[".env.bin"], "not UTF-8 text");
      assertStringIncludes(why[".env.claude"], "sk-ant");
      assertEquals(why[".env.big"], "over 64 KiB");
      assertEquals(why[".env.link"], "a symlink");
      assertEquals(why["a/b/c/d/.env"], "more than three folders down");
      assertEquals(why["node_modules/x/.env"], "under node_modules/");
      assert(!(".env.example" in why), "a tracked file is in the clone already");
      // the values travel only in b64, and nothing else of the repository
      assertEquals(atob(files[0].b64), "A=1\n");

      // another clone: what git ignores there and has a folder for is written 0600; a differing file is kept
      const clone = `${home}/clone`;
      assert(await git(home, ["clone", "--quiet", repo, clone]));
      await Deno.mkdir(`${clone}/apps/web`, { recursive: true });
      await Deno.writeTextFile(`${clone}/apps/web/.dev.vars`, "B=mine\n");
      const logs: string[] = [];
      const extra = [
        { path: "missing/.env", mode: 0o600, b64: btoa("M=1\n") },
        { path: ".env.example.local", mode: 0o600, b64: btoa("E=1\n") },
      ];
      // this clone's .gitignore no longer ignores `.env.*`: such a file is never written there
      await Deno.writeTextFile(`${clone}/.gitignore`, ".env\n.dev.vars\n");
      const r = await applySeedFiles(clone, [...files, ...extra], (s) => logs.push(s));
      assertEquals(r.written, [".env"]);
      assertEquals(r.kept, ["apps/web/.dev.vars"]);
      assertEquals(r.skipped.map((s) => s.path).sort(), [".env.example.local", "missing/.env"]);
      assertEquals(await Deno.readTextFile(`${clone}/.env`), "A=1\n");
      assertEquals((await Deno.stat(`${clone}/.env`)).mode! & 0o777, 0o600);
      assertEquals(await Deno.readTextFile(`${clone}/apps/web/.dev.vars`), "B=mine\n");
      assertEquals(logs.length, 1);
      assert(!logs[0].includes("B=2") && !logs[0].includes("mine"), "values are never logged");
      // again: the same file is left, the difference is not said twice
      const r2 = await applySeedFiles(clone, files, (s) => logs.push(s));
      assertEquals(r2.same, [".env"]);
      assertEquals(logs.length, 1);
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});
