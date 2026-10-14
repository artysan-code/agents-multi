// policy_test.ts — the run policy (shared/mcp/lib/policy.ts): what resolves, what a push may reach, and the
// hook git actually runs. Hermetic: a temp directory, a git with no global or system configuration, the
// real repository's config never read or written.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  DEFAULT_POLICY,
  hookScript,
  isolate,
  loadPolicy,
  type Policy,
  pushableRefs,
  pushAllowed,
  resolvePolicy,
  worktreesOf,
} from "../../../shared/mcp/lib/policy.ts";

const ZERO = "0".repeat(40);
const SHA = "a".repeat(40);

Deno.test("policy: the defaults are ADR 0009's — dev yes, main and release never", () => {
  const p = resolvePolicy();
  assertEquals(p, DEFAULT_POLICY);
  assertEquals(pushableRefs(p, "r1"), ["refs/heads/agent/r1", "refs/heads/dev"]);
  assert(pushAllowed("refs/heads/agent/r1", SHA, p, "r1"));
  assert(pushAllowed("refs/heads/dev", SHA, p, "r1"));
  for (const b of ["main", "master", "release", "agent/other", "feature/x"]) {
    assert(!pushAllowed(`refs/heads/${b}`, SHA, p, "r1"), b);
  }
  assert(!pushAllowed("refs/tags/v1", SHA, p, "r1"));
  assert(!pushAllowed("refs/heads/agent/r1", ZERO, p, "r1"), "a deletion is never allowed");
});

Deno.test("policy: the owner's file loosens but never past the floor; a repo's file only tightens", () => {
  // the owner tries to allow main and to drop the protection of release
  const owner = resolvePolicy({ pushBranches: ["dev", "main", "staging"], protectedBranches: [], timeoutMin: 300 });
  assertEquals(owner.pushBranches, ["dev", "staging"]);
  assertEquals(owner.protectedBranches, ["main", "master", "release"]);
  assertEquals(owner.timeoutMin, 300);
  // a repo asks for more: ignored; asks for less: obeyed
  const more = resolvePolicy({ timeoutMin: 60, maxConcurrent: 1 }, {
    timeoutMin: 600,
    maxConcurrent: 9,
    pushBranches: ["dev", "x"],
  });
  assertEquals([more.timeoutMin, more.maxConcurrent, more.pushBranches], [60, 1, ["dev"]]);
  const less = resolvePolicy(undefined, {
    push: false,
    commit: false,
    pushBranches: [],
    protectedBranches: ["beta"],
    timeoutMin: 10,
  });
  assertEquals([less.push, less.commit, less.pushBranches, less.timeoutMin], [false, false, [], 10]);
  assert(less.protectedBranches.includes("beta") && less.protectedBranches.includes("main"));
  assertEquals(pushableRefs(less, "r"), []);
  assert(!pushAllowed("refs/heads/agent/r", SHA, less, "r"));
});

Deno.test("policy: junk in a file is ignored, never trusted", () => {
  const p = resolvePolicy({
    devBranch: "a b; rm -rf",
    pushBranches: ["ok", "$(x)", 3, "../x"],
    timeoutMin: "soon",
    maxConcurrent: -4,
  }, "text");
  assertEquals(p.devBranch, "dev");
  assertEquals(p.pushBranches, ["ok"]);
  assertEquals(p.timeoutMin, DEFAULT_POLICY.timeoutMin);
  assertEquals(p.maxConcurrent, 1);
});

Deno.test("policy: the hook text names its allow list and the protected branches", () => {
  const h = hookScript(DEFAULT_POLICY, "night-1");
  assertStringIncludes(h, '"refs/heads/agent/night-1" "refs/heads/dev"');
  assertStringIncludes(h, '"refs/heads/main" "refs/heads/master" "refs/heads/release"');
});

// ---------------------------------------------------------------- git, for real

async function git(cwd: string, args: string[], env: Record<string, string>) {
  const r = await new Deno.Command("git", { args, cwd, env, clearEnv: true, stdout: "piped", stderr: "piped" })
    .output();
  return {
    ok: r.success,
    out: new TextDecoder().decode(r.stdout).trim(),
    err: new TextDecoder().decode(r.stderr).trim(),
  };
}

Deno.test("policy: a worktree's hook lets the branch and dev through and stops main, release, tags, deletes", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "am-policy-" });
  const real = await Deno.realPath(tmp);
  // git as the tests see it: no user, global or system configuration of the machine, one fixed identity
  const env = {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: real,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  // a hook (pre-commit, pre-push) runs the gate with GIT_DIR, GIT_INDEX_FILE and the like set: they would
  // point isolate()'s git at the repository being committed, not at ours
  const ambient = Object.keys(Deno.env.toObject()).filter((k) => k.startsWith("GIT_") && !(k in env));
  const saved = Object.fromEntries([...Object.keys(env), ...ambient].map((k) => [k, Deno.env.get(k)]));
  for (const k of ambient) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v); // isolate() runs git with this process's environment
  try {
    const repo = `${real}/repo`, remote = `${real}/remote.git`;
    await Deno.mkdir(repo);
    for (
      const [cwd, args] of [
        [real, ["init", "--bare", "-b", "dev", remote]],
        [repo, ["init", "-b", "dev"]],
        [repo, ["remote", "add", "origin", remote]],
      ] as [string, string[]][]
    ) assert((await git(cwd, args, env)).ok, args.join(" "));
    await Deno.writeTextFile(`${repo}/a.txt`, "a\n");
    for (
      const args of [["add", "."], ["commit", "-m", "first"], ["push", "origin", "dev"], ["push", "origin", "dev:main"]]
    ) {
      const r = await git(repo, args, env);
      assert(r.ok, `${args.join(" ")}: ${r.err}`);
    }

    const mainBefore = (await git(remote, ["rev-parse", "refs/heads/main"], env)).out;
    const policy: Policy = resolvePolicy();
    const iso = await isolate(repo, "night-1", policy);
    assertEquals(iso.path, `${worktreesOf(repo)}/agent-night-1`);
    assertEquals(iso.branch, "agent/night-1");
    assertEquals((await git(iso.path, ["rev-parse", "--abbrev-ref", "HEAD"], env)).out, "agent/night-1");

    await Deno.writeTextFile(`${iso.path}/b.txt`, "b\n");
    assert((await git(iso.path, ["add", "."], env)).ok);
    assert((await git(iso.path, ["commit", "-m", "work"], env)).ok, "commits are allowed");

    const push = (ref: string, from = "HEAD") => git(iso.path, ["push", "origin", `${from}:${ref}`], env);
    assert((await push("refs/heads/agent/night-1")).ok, "its own branch");
    assert((await push("refs/heads/dev")).ok, "the development branch");
    for (
      const ref of ["refs/heads/main", "refs/heads/release", "refs/heads/master", "refs/heads/other", "refs/tags/v9"]
    ) {
      const r = await push(ref);
      assert(!r.ok, `${ref} must be refused`);
      assertStringIncludes(r.err, "agents-multi policy");
    }
    const del = await git(iso.path, ["push", "origin", ":refs/heads/agent/night-1"], env);
    assert(!del.ok, "deleting is refused");
    const sha = async (ref: string) => (await git(remote, ["rev-parse", ref], env)).out;
    assertEquals(await sha("refs/heads/main"), mainBefore, "main stayed where it was");
    assert((await sha("refs/heads/dev")) !== mainBefore, "while dev moved");
    assertEquals(await sha("refs/heads/agent/night-1"), await sha("refs/heads/dev"));

    // the main checkout has no hook of the worktree's: it is not under the policy
    assertEquals((await git(repo, ["config", "--local", "core.hooksPath"], env)).out, "");
    // a fresh policy loaded from a repo with a tightening file
    await Deno.mkdir(`${repo}/.agents`);
    await Deno.writeTextFile(`${repo}/.agents/policy.json`, JSON.stringify({ push: false }));
    assertEquals((await loadPolicy(repo, `${real}/noconfig`)).push, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(tmp, { recursive: true });
  }
});
