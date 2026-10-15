// moving_test.ts — work that moves between machines (shared/mcp/lib/moving.ts): a run's branch and HANDOFFs
// pushed as checkpoints from one clone, found and continued in another clone of the same remote, as a second
// machine would. Hermetic: a temp directory, a git with no global or system configuration.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { checkpoint, findClone, remoteOf, resumeNote, resumeWorktree } from "../../../shared/mcp/lib/moving.ts";
import { isolate, resolvePolicy } from "../../../shared/mcp/lib/policy.ts";
import { normalRemote } from "../../../shared/mcp/lib/nodes.ts";

async function git(cwd: string, args: string[]) {
  const r = await new Deno.Command("git", { args, cwd, stdout: "piped", stderr: "piped" }).output();
  return { ok: r.success, out: new TextDecoder().decode(r.stdout).trim(), err: new TextDecoder().decode(r.stderr) };
}

Deno.test("moving: a run checkpointed on one machine resumes on another from its branch and HANDOFFs", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "am-moving-" });
  const real = await Deno.realPath(tmp);
  const env = {
    HOME: real,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  // a hook running the gate sets GIT_DIR and the like: they would point git at the repository being committed
  const ambient = Object.keys(Deno.env.toObject()).filter((k) => k.startsWith("GIT_") && !(k in env));
  const saved = Object.fromEntries([...Object.keys(env), ...ambient].map((k) => [k, Deno.env.get(k)]));
  for (const k of ambient) Deno.env.delete(k);
  for (const [k, v] of Object.entries(env)) Deno.env.set(k, v);
  try {
    const remote = `${real}/remote.git`, a = `${real}/desk/site`, b = `${real}/srv/work/site`;
    assert((await git(real, ["init", "--quiet", "--bare", "-b", "dev", remote])).ok);
    await Deno.mkdir(a, { recursive: true });
    for (const args of [["init", "--quiet", "-b", "dev"], ["remote", "add", "origin", remote]]) {
      assert((await git(a, args)).ok);
    }
    await Deno.writeTextFile(`${a}/a.txt`, "a\n");
    for (const args of [["add", "."], ["commit", "--quiet", "-m", "first"], ["push", "--quiet", "origin", "dev"]]) {
      assert((await git(a, args)).ok, args.join(" "));
    }
    assertEquals(await remoteOf(a), normalRemote(remote));

    // machine one: the run works, commits, writes a HANDOFF; the checkpoint pushes both
    const policy = resolvePolicy();
    const iso = await isolate(a, "night-1", policy);
    await Deno.writeTextFile(`${iso.path}/b.txt`, "b\n");
    assert((await git(iso.path, ["add", "b.txt"])).ok);
    assert((await git(iso.path, ["commit", "--quiet", "-m", "half the work"])).ok);
    await Deno.mkdir(`${iso.path}/.agents/runs/r1`, { recursive: true });
    await Deno.writeTextFile(`${iso.path}/.agents/runs/r1/review.md`, "# review\nfound two things\n");
    const first = await checkpoint(iso.path, "night-1", {});
    assertEquals(first.pushed, ["agent/night-1", "refs/agents/night-1"]);
    assertEquals((await checkpoint(iso.path, "night-1", first)).pushed, [], "nothing moved, nothing pushed");
    assertEquals(
      (await git(iso.path, ["diff", "--cached", "--name-only"])).out,
      "",
      "the worktree's index is untouched",
    );
    await Deno.writeTextFile(`${iso.path}/.agents/runs/r1/fix.md`, "# fix\nhalf done\n");
    assertEquals((await checkpoint(iso.path, "night-1", first)).pushed, ["refs/agents/night-1"]);

    // machine two: its own clone, found by the remote; the run continues on the same branch
    await Deno.mkdir(`${real}/srv/work`, { recursive: true });
    assert((await git(`${real}/srv/work`, ["clone", "--quiet", remote, "site"])).ok);
    assertEquals(await findClone(normalRemote(remote), ["~/srv"], real), b);
    assertEquals(await findClone("git.example.com/other", ["~/srv"], real), null);
    const there = await resumeWorktree(b, "night-1", policy);
    assertEquals(there.branch, "agent/night-1");
    assertEquals(await Deno.readTextFile(`${there.path}/b.txt`), "b\n", "the committed work came along");
    assertEquals(there.handoffs.map((f) => f.slice(there.path.length)).sort(), [
      "/.agents/runs/r1/fix.md",
      "/.agents/runs/r1/review.md",
    ]);
    assertStringIncludes(await Deno.readTextFile(`${there.path}/.agents/runs/r1/review.md`), "found two things");
    assertEquals((await git(there.path, ["status", "--porcelain"])).out, "", "HANDOFFs stay out of git there too");
    // and it goes on pushing its branch, under the same hook
    await Deno.writeTextFile(`${there.path}/c.txt`, "c\n");
    assert((await git(there.path, ["add", "c.txt"])).ok);
    assert((await git(there.path, ["commit", "--quiet", "-m", "the rest"])).ok);
    assertEquals((await checkpoint(there.path, "night-1", {})).pushed, ["agent/night-1", "refs/agents/night-1"]);
    const main = await git(there.path, ["push", "origin", "HEAD:refs/heads/main"]);
    assert(!main.ok, "main is still refused");

    // a run that never reached the remote cannot move
    const lost = await resumeWorktree(b, "never-pushed", policy).then(() => "", (e) => (e as Error).message);
    assertStringIncludes(lost, "not on the remote");
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("moving: the resumed child is told where the work came from and what it left", () => {
  const n = resumeNote("desk", "agent/n-1", "dev", ["/w/.agents/runs/r1/review.md"]);
  assertStringIncludes(n, "the machine desk");
  assertStringIncludes(n, "git log dev..HEAD");
  assertStringIncludes(n, "/w/.agents/runs/r1/review.md");
  assertStringIncludes(resumeNote("desk", "agent/n-1", "dev", []), "no HANDOFF");
});
