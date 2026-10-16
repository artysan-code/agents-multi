// node_clone_test.ts — a repository cloned on first need (apps/cli/node/clone.ts, ADR 0014 slice A): which remotes
// the owner allowed, matched on the parsed remote and never by substring; where the clone goes; and, hermetic in a
// temp home whose git config rewrites the forge's address to a local bare repository, a clone made, one found, one
// refused, one that fails and leaves nothing.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  badUrl,
  cloneEnv,
  cloneName,
  cloneTarget,
  ensureClone,
  hostCovers,
  remoteAllowed,
  resetTold,
  splitRemote,
} from "../node/clone.ts";
import { cleanNodeConfig } from "../../../shared/mcp/lib/headless.ts";

Deno.test("clone: a clone's name from its remote", () => {
  assertEquals(cloneName("git@git.example:me/agents-multi.git"), "agents-multi");
  assertEquals(cloneName("ssh://git@git.example:2222/me/site"), "site");
  assertEquals(cloneName("https://github.com/me/tool.git/"), "tool");
});

Deno.test("clone: addresses with another scheme or credentials are refused", () => {
  assertEquals(badUrl("git@git.example.me:owner/repo.git"), null);
  assertEquals(badUrl("ssh://git@git.example.me:2222/owner/repo.git"), null);
  assertEquals(badUrl("https://github.com/owner/repo"), null);
  assert(badUrl("file:///etc/repo"));
  assert(badUrl("git://git.example.me/owner/repo"));
  assert(badUrl("ext::sh -c touch% /tmp/x"));
  assertStringIncludes(badUrl("https://user:ghp_secret@github.com/owner/repo")!, "credentials");
  assertStringIncludes(badUrl("https://ghp_secret@github.com/owner/repo")!, "credentials");
  assertStringIncludes(badUrl("ssh://git:pw@git.example.me/owner/repo")!, "credentials");
});

Deno.test("clone: gitHosts match on the parsed remote, never by substring", () => {
  assertEquals(splitRemote("ssh://git@git.example.me:2222/owner/repo.git"), {
    host: "git.example.me",
    port: "2222",
    path: ["owner", "repo"],
  });
  assert(hostCovers("git.example.me", "git.example.me/owner/repo"));
  assert(hostCovers("git.example.me", "git@git.example.me:owner/repo.git"));
  assert(hostCovers("git.example.me", "git.example.me:2222/owner/repo"));
  assert(!hostCovers("git.example.me:2222", "git.example.me/owner/repo"));
  assert(!hostCovers("git.example.me", "git.example.me.evil.org/owner/repo"));
  assert(!hostCovers("example.me", "git.example.me/owner/repo"));
  assert(hostCovers("github.com/me", "github.com/me/tool"));
  assert(!hostCovers("github.com/me", "github.com/meme/tool"));
  assert(!hostCovers("github.com/me", "github.com/other/me"));
  assert(!hostCovers("github.com", "github.com/only-owner"));
});

Deno.test("clone: only a remote in repos or under gitHosts is allowed, with the address to clone it from", () => {
  const cfg = cleanNodeConfig({
    repos: ["ssh://git@git.example.me:2222/owner/site.git"],
    gitHosts: ["git.example.me", "GitHub.com/me", "https://bad", "*.evil"],
  });
  assertEquals(cfg.gitHosts, ["git.example.me", "github.com/me"]);
  assertEquals(remoteAllowed(cfg, "git.example.me:2222/owner/site"), {
    ok: true,
    via: "repos",
    url: "ssh://git@git.example.me:2222/owner/site.git",
  });
  assertEquals(remoteAllowed(cfg, "git.example.me/owner/blog"), {
    ok: true,
    via: "gitHosts",
    url: "ssh://git@git.example.me/owner/blog.git",
  });
  assertEquals(remoteAllowed(cfg, "https://github.com/me/tool"), {
    ok: true,
    via: "gitHosts",
    url: "https://github.com/me/tool",
  });
  assertEquals(remoteAllowed(cfg, "github.com/client/app"), { ok: false, why: "not in repos or gitHosts" });
  assertEquals(remoteAllowed(cfg, "git.example.me.evil.org/owner/x").ok, false);
  assertEquals(remoteAllowed(cfg, "https://u:tok@github.com/me/tool").ok, false);
  // nothing listed: nothing cloned on need
  assertEquals(cleanNodeConfig({}).gitHosts, undefined);
  assertEquals(remoteAllowed(cleanNodeConfig({}), "github.com/me/tool").ok, false);
});

Deno.test("clone: under the first root, by name; git gets no agent, no prompt, the node's key only", () => {
  assertEquals(cloneTarget({ repoRoots: ["~/work", "/srv"] }, "git@h:o/site.git", "/home/n"), "/home/n/work/site");
  assertEquals(cloneTarget({ repoRoots: [] }, "git@h:o/site.git", "/home/n"), "/home/n/site");
  const env = cloneEnv("/home/n", "/usr/bin");
  assertEquals(Object.keys(env).sort(), ["GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "HOME", "PATH"]);
  assertStringIncludes(env.GIT_SSH_COMMAND, "-i /home/n/.ssh/id_ed25519");
  assertStringIncludes(env.GIT_SSH_COMMAND, "IdentityAgent=none");
  assertStringIncludes(env.GIT_SSH_COMMAND, "BatchMode=yes");
});

async function git(cwd: string, args: string[], env: Record<string, string>) {
  const r = await new Deno.Command("git", { args, cwd, env, clearEnv: true, stdout: "piped", stderr: "piped" })
    .output();
  return r.success;
}

Deno.test("clone: ensureClone finds, clones an allowed remote, refuses the rest, and a failure leaves nothing", async () => {
  resetTold();
  const home = await Deno.realPath(await Deno.makeTempDir({ prefix: "am-clone-" }));
  const env = {
    HOME: home,
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  // a hook running the gate sets GIT_DIR and the like: findClone's git would read the repository being committed
  const ambient = Object.keys(Deno.env.toObject()).filter((k) => k.startsWith("GIT_"));
  const saved = Object.fromEntries(ambient.map((k) => [k, Deno.env.get(k)!]));
  for (const k of ambient) Deno.env.delete(k);
  try {
    // the forge: a bare repository the node's git config reaches in place of ssh://git@git.example.me/owner/site.git
    const bare = `${home}/forge/site.git`, work = `${home}/seedwork`;
    await Deno.mkdir(work, { recursive: true });
    assert(await git(home, ["init", "--quiet", "--bare", "-b", "dev", bare], env));
    assert(await git(work, ["init", "--quiet", "-b", "dev"], env));
    await Deno.writeTextFile(`${work}/a.txt`, "a\n");
    assert(await git(work, ["add", "."], env));
    assert(await git(work, ["commit", "--quiet", "-m", "first"], env));
    assert(await git(work, ["push", "--quiet", bare, "dev"], env));
    await Deno.writeTextFile(
      `${home}/.gitconfig`,
      `[url "file://${bare}"]\n\tinsteadOf = ssh://git@git.example.me/owner/site.git\n` +
        `[url "file://${home}/forge/missing.git"]\n\tinsteadOf = ssh://git@git.example.me/owner/gone.git\n` +
        `[protocol "file"]\n\tallow = always\n`,
    );
    const cfg = cleanNodeConfig({ repoRoots: ["~/work"], gitHosts: ["git.example.me"] });
    const seeded: string[] = [], told: string[] = [];
    let now = 0;
    const o = {
      home,
      seed: (dir: string, repo: string) => (seeded.push(`${dir} ${repo}`), Promise.resolve()),
      notify: (_t: string, b: string) => told.push(b),
      now: () => now,
    };

    // a stranger's remote: refused with its reason, nothing cloned
    const refused = await ensureClone(cfg, "github.com/client/app", o);
    assert("why" in refused);
    assertStringIncludes(refused.why, "not in repos or gitHosts");

    // allowed: cloned under the first root, then seeded
    const made = await ensureClone(cfg, "git.example.me/owner/site", o);
    assertEquals(made, { dir: `${home}/work/site`, cloned: true });
    assertEquals(await Deno.readTextFile(`${home}/work/site/a.txt`), "a\n");
    assertEquals(seeded, [`${home}/work/site git.example.me/owner/site`]);
    // the clone's origin is the address it was cloned from, so findClone knows it again
    const again = await ensureClone(cfg, "ssh://git@git.example.me/owner/site.git", o);
    assertEquals(again, { dir: `${home}/work/site`, cloned: false });
    assertEquals(seeded.length, 2);

    // a clone that fails: nothing left under the root, the owner told once an hour
    const failed = await ensureClone(cfg, "git.example.me/owner/gone", o);
    assert("why" in failed);
    const left = [...Deno.readDirSync(`${home}/work`)].map((e) => e.name);
    assertEquals(left, ["site"]);
    await ensureClone(cfg, "git.example.me/owner/gone", o);
    assertEquals(told.length, 1);
    now += 3600_000;
    await ensureClone(cfg, "git.example.me/owner/gone", o);
    assertEquals(told.length, 2);

    // a folder of that name that is not its clone is never cloned over
    await Deno.mkdir(`${home}/work/gone`);
    const busy = await ensureClone(cfg, "git.example.me/owner/gone", o);
    assert("why" in busy);
    assertStringIncludes(busy.why, "exists and is not a clone");
  } finally {
    for (const [k, v] of Object.entries(saved)) Deno.env.set(k, v);
    await Deno.remove(home, { recursive: true });
  }
});
