// moving.ts — how a run's work leaves its machine and comes back on another (ADR 0012): the run's branch
// `agent/<id>` is pushed as it moves, its HANDOFFs (`.agents/runs/`, outside git, ADR 0005) as a commit of their
// own on `refs/agents/<id>`; another node finds the repository by its remote, continues the same branch in a
// worktree of its own and puts the HANDOFFs back. Never a process: a branch and its notes.

import { normalRemote } from "./nodes.ts";
import { isolate, type Isolated, type Policy } from "./policy.ts";

async function git(dir: string, args: string[], env?: Record<string, string>): Promise<string> {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args], env, stdout: "piped", stderr: "piped" })
    .output();
  if (!r.success) throw new Error(`git ${args[0]}: ${new TextDecoder().decode(r.stderr).trim()}`);
  return new TextDecoder().decode(r.stdout).trim();
}
const tryGit = (dir: string, args: string[], env?: Record<string, string>) => git(dir, args, env).catch(() => null);

/** The remote a repository's work moves through (`origin`), as nodes compare it; null without one. */
export async function remoteOf(dir: string): Promise<string | null> {
  const url = await tryGit(dir, ["remote", "get-url", "origin"]);
  return url ? normalRemote(url) : null;
}

/** A clone of `repo` (a normalised remote) under one of `roots`, a few folders deep: a main checkout, never a
 *  run's worktree (`*-wt`) nor what is inside node_modules. */
export async function findClone(repo: string, roots: string[], home: string, depth = 3): Promise<string | null> {
  const walk = async (dir: string, left: number): Promise<string | null> => {
    const st = await Deno.lstat(`${dir}/.git`).catch(() => null);
    if (st?.isDirectory) return (await remoteOf(dir)) === repo ? dir : null;
    if (left === 0) return null;
    const subs: string[] = [];
    try {
      for await (const e of Deno.readDir(dir)) {
        if (e.isDirectory && !e.name.startsWith(".") && e.name !== "node_modules" && !e.name.endsWith("-wt")) {
          subs.push(`${dir}/${e.name}`);
        }
      }
    } catch { /* unreadable */ }
    for (const s of subs.sort()) {
      const hit = await walk(s, left - 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const r of roots) {
    const hit = await walk(r.replace(/^~(?=\/|$)/, home), depth);
    if (hit) return hit;
  }
  return null;
}

/** Where a checkpoint stands: the branch's head and the HANDOFFs' tree last pushed. */
export interface Mark {
  head?: string;
  handoffs?: string;
}

/** Pushes what moved since `last`: the branch when its head changed, the HANDOFFs (a commit holding
 *  `.agents/runs/`, built in a scratch index so the worktree's own is untouched) when they changed. The run's
 *  pre-push hook lets exactly these refs through. Returns the new mark and what it pushed. */
export async function checkpoint(worktree: string, id: string, last: Mark): Promise<Mark & { pushed: string[] }> {
  const pushed: string[] = [];
  const head = await git(worktree, ["rev-parse", "HEAD"]);
  if (head !== last.head) {
    await git(worktree, ["push", "--quiet", "origin", `HEAD:refs/heads/agent/${id}`]);
    pushed.push(`agent/${id}`);
  }
  let handoffs = last.handoffs;
  if (await Deno.stat(`${worktree}/.agents/runs`).catch(() => null)) {
    const index = await Deno.makeTempFile({ prefix: "am-handoffs-" });
    try {
      await Deno.remove(index); // git makes it: an empty file is not an index
      const env = { GIT_INDEX_FILE: index };
      await git(worktree, ["add", "--force", ".agents/runs"], env);
      const tree = await git(worktree, ["write-tree"], env);
      if (tree !== last.handoffs) {
        const commit = await git(worktree, ["commit-tree", tree, "-m", `HANDOFFs of agent/${id}`]);
        await git(worktree, ["push", "--quiet", "origin", `+${commit}:refs/agents/${id}`]);
        pushed.push(`refs/agents/${id}`);
      }
      handoffs = tree;
    } finally {
      await Deno.remove(index).catch(() => {});
    }
  }
  return { head, handoffs, pushed };
}

/** Continues run `id` on this machine: its branch and HANDOFFs fetched from the remote, a worktree of its own
 *  on the same branch under the run policy's hook, the HANDOFFs back in its `.agents/runs/`. */
export async function resumeWorktree(
  project: string,
  id: string,
  p: Policy,
): Promise<Isolated & { handoffs: string[] }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`not a run id: ${id}`);
  const remote = `refs/remotes/origin/agent/${id}`;
  await git(project, ["fetch", "--quiet", "origin", `+refs/heads/agent/${id}:${remote}`]).catch((e) => {
    throw new Error(`the branch agent/${id} is not on the remote: nothing to resume (${(e as Error).message})`);
  });
  const notes = await tryGit(project, ["fetch", "--quiet", "origin", `+refs/agents/${id}:refs/agents/${id}`]);
  const iso = await isolate(project, id, p, remote);
  const handoffs: string[] = [];
  if (notes !== null) {
    const files = (await git(project, ["ls-tree", "-r", "--name-only", `refs/agents/${id}`])).split("\n")
      .filter((f) => f.startsWith(".agents/runs/") && !f.split("/").includes(".."));
    for (const f of files) {
      const text = await git(project, ["show", `refs/agents/${id}:${f}`]);
      await Deno.mkdir(`${iso.path}/${f.slice(0, f.lastIndexOf("/"))}`, { recursive: true });
      await Deno.writeTextFile(`${iso.path}/${f}`, text + "\n");
      handoffs.push(`${iso.path}/${f}`);
    }
  }
  // the HANDOFFs stay out of git there too (ADR 0005)
  const exclude = `${await git(project, ["rev-parse", "--path-format=absolute", "--git-common-dir"])}/info/exclude`;
  const now = await Deno.readTextFile(exclude).catch(() => "");
  if (!now.split("\n").includes(".agents/")) {
    await Deno.mkdir(exclude.slice(0, exclude.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(exclude, `${now}${now && !now.endsWith("\n") ? "\n" : ""}.agents/\n`);
  }
  return { ...iso, handoffs };
}

/** Pure: what a resumed run's child is told before its task: it continues work a machine dropped. */
export function resumeNote(from: string, branch: string, base: string, handoffs: string[]): string {
  return [
    `You continue work that the machine ${from} started and could not finish (it went off or stopped answering).`,
    `The branch ${branch} holds what it committed: read \`git log ${base}..HEAD\` and the diff first; anything it had`,
    "not committed is lost. Do not redo what is done.",
    handoffs.length
      ? `The HANDOFFs it left (read them): ${handoffs.join(", ")}.`
      : "It left no HANDOFF: the commits are all there is.",
  ].join("\n");
}
