// policy.ts — what an unattended run may do to a repository (ADR 0010), enforced by the runner and by
// git, not by the prompt: the run works in its own worktree on its own branch `agent/<id>`, and a
// pre-push hook installed for that worktree alone refuses every push but its own branch and the
// development branch. main, master and release are never pushable, whatever a policy file says.

import { configDir } from "./owner.ts";

export interface Policy {
  /** the branch a run starts from, and may push to besides its own */
  devBranch: string;
  /** branches a run may push to, besides its own */
  pushBranches: string[];
  /** never pushable; a policy can add to it, never remove from it */
  protectedBranches: string[];
  /** may it commit */
  commit: boolean;
  /** may it push at all (its own branch included) */
  push: boolean;
  /** a run still going after this many minutes is stopped */
  timeoutMin: number;
  /** unattended runs at once, over all the routines of the machine */
  maxConcurrent: number;
}

/** The floor: ADR 0009, 19. */
export const NEVER_PUSH = ["main", "master", "release"];

export const DEFAULT_POLICY: Policy = {
  devBranch: "dev",
  pushBranches: ["dev"],
  protectedBranches: [...NEVER_PUSH],
  commit: true,
  push: true,
  timeoutMin: 120,
  maxConcurrent: 2,
};

const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,100}$/;
const isBranch = (s: unknown): s is string => typeof s === "string" && BRANCH.test(s) && !s.includes("..");
const names = (v: unknown) => Array.isArray(v) ? v.filter(isBranch) : undefined;
const count = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : undefined;

/** Pure: a policy file's content, kept to what is valid (the rest is ignored, never trusted). */
export function cleanPolicy(raw: unknown): Partial<Policy> {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Partial<Policy> = {};
  if (isBranch(r.devBranch)) out.devBranch = r.devBranch;
  const push = names(r.pushBranches);
  if (push) out.pushBranches = push;
  const prot = names(r.protectedBranches);
  if (prot) out.protectedBranches = prot;
  if (typeof r.commit === "boolean") out.commit = r.commit;
  if (typeof r.push === "boolean") out.push = r.push;
  const t = count(r.timeoutMin, 1, 24 * 60);
  if (t !== undefined) out.timeoutMin = t;
  const c = count(r.maxConcurrent, 1, 16);
  if (c !== undefined) out.maxConcurrent = c;
  return out;
}

/** Pure: the policy of a run. The owner's file (in their configuration) may set anything over the
 *  defaults except lowering the floor (`NEVER_PUSH`); the repository's file (`.agents/policy.json`) may
 *  only tighten what it is given: fewer branches, shorter time, less concurrency, no commit or push. */
export function resolvePolicy(owner?: unknown, repo?: unknown): Policy {
  const o = cleanPolicy(owner);
  const base: Policy = {
    ...DEFAULT_POLICY,
    ...o,
    protectedBranches: [...new Set([...NEVER_PUSH, ...(o.protectedBranches ?? [])])],
  };
  const r = cleanPolicy(repo);
  const p: Policy = {
    ...base,
    pushBranches: r.pushBranches ? base.pushBranches.filter((b) => r.pushBranches!.includes(b)) : base.pushBranches,
    protectedBranches: [...new Set([...base.protectedBranches, ...(r.protectedBranches ?? [])])],
    commit: base.commit && r.commit !== false,
    push: base.push && r.push !== false,
    timeoutMin: Math.min(base.timeoutMin, r.timeoutMin ?? base.timeoutMin),
    maxConcurrent: Math.min(base.maxConcurrent, r.maxConcurrent ?? base.maxConcurrent),
  };
  p.pushBranches = p.pushBranches.filter((b) => !p.protectedBranches.includes(b));
  return p;
}

/** The refs a run `id` may push to, as git names them (the hook's allow list): its branch, its checkpoint of
 *  HANDOFFs (`refs/agents/<id>`, ADR 0012: what lets it resume on another machine), the policy's branches. */
export function pushableRefs(p: Policy, id: string): string[] {
  if (!p.push) return [];
  return [`refs/heads/agent/${id}`, `refs/agents/${id}`, ...p.pushBranches.map((b) => `refs/heads/${b}`)];
}

/** Pure: whether a push of `localSha` to the remote ref is allowed: only to a branch on the list; a
 *  deletion never. */
export function pushAllowed(remoteRef: string, localSha: string, p: Policy, id: string): boolean {
  if (/^0+$/.test(localSha)) return false;
  const branch = remoteRef.replace(/^refs\/heads\//, "");
  if (remoteRef === `refs/agents/${id}`) return pushableRefs(p, id).includes(remoteRef);
  if (!remoteRef.startsWith("refs/heads/") || p.protectedBranches.includes(branch)) return false;
  return pushableRefs(p, id).includes(remoteRef);
}

/** The deny rules a child is given (`--disallowedTools`): the ways round the hook that a mistake takes.
 *  A guard against error — the boundary is the hook (and the sandbox, ADR 0009, 24). */
export const DENY_TOOLS = [
  "Bash(git push --no-verify:*)",
  "Bash(git push * --no-verify*)",
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(git push * --force*)",
  "Bash(git config * core.hooksPath*)",
  "Bash(git -c *)",
];

/** Pure: the text of the pre-push hook for a run. It reads git's lines (`<local ref> <local sha> <remote
 *  ref> <remote sha>`) and refuses the push when one names a ref outside the list. */
export function hookScript(p: Policy, id: string): string {
  const refs = pushableRefs(p, id);
  if (refs.some((r) => !/^refs\/(heads|agents)\/[A-Za-z0-9._\/-]+$/.test(r))) {
    throw new Error("a branch name the hook cannot hold");
  }
  const prot = p.protectedBranches.map((b) => `refs/heads/${b}`);
  return [
    "#!/usr/bin/env bash",
    `# agents-multi run policy for agent/${id} (ADR 0010): written by the runner, not to be edited.`,
    `allowed=(${refs.map((r) => `"${r}"`).join(" ")})`,
    `protected=(${prot.map((r) => `"${r}"`).join(" ")})`,
    "while read -r lref lsha rref rsha; do",
    '  if [[ $lsha =~ ^0+$ ]]; then echo "agents-multi policy: deleting $rref is not allowed" >&2; exit 1; fi',
    '  for b in "${protected[@]}"; do',
    '    [[ $rref == "$b" ]] && { echo "agents-multi policy: $rref is never pushed by a run" >&2; exit 1; }',
    "  done",
    "  ok=0",
    '  for a in "${allowed[@]}"; do [[ $rref == "$a" ]] && ok=1; done',
    '  if [[ $ok != 1 ]]; then echo "agents-multi policy: a run may push only agent/' + id +
    (p.pushBranches.length ? ` and ${p.pushBranches.join(", ")}` : "") + ', not $rref" >&2; exit 1; fi',
    "done",
    "exit 0",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- on disk

/** The policy for a repository: the owner's file in their configuration (`policy.json`), then the
 *  repository's `.agents/policy.json`, which can only tighten (the folder is excluded from git, ADR 0005). */
export async function loadPolicy(project: string, config = configDir()): Promise<Policy> {
  const read = (f: string) => Deno.readTextFile(f).then(JSON.parse).catch(() => undefined);
  return resolvePolicy(await read(`${config}/policy.json`), await read(`${project}/.agents/policy.json`));
}

async function git(dir: string, args: string[]): Promise<string> {
  const r = await new Deno.Command("git", { args: ["-C", dir, ...args], stdout: "piped", stderr: "piped" }).output();
  if (!r.success) throw new Error(`git ${args[0]}: ${new TextDecoder().decode(r.stderr).trim()}`);
  return new TextDecoder().decode(r.stdout).trim();
}

export interface Isolated {
  /** the worktree the run works in */
  path: string;
  branch: string;
  base: string;
  hooks: string;
}

/** Where a project's run worktrees live: `<parent>/<project>-wt/`, beside the repository. */
export const worktreesOf = (project: string) => `${project.replace(/\/+$/, "")}-wt`;

/** A dedicated worktree for run `id` on a new branch `agent/<id>`, from the development branch (or HEAD
 *  where the repository has none), with the pre-push hook set for that worktree alone (`config --worktree`,
 *  so the other worktrees and the main checkout are untouched). `from`: a commit to continue instead (a run
 *  resumed on another machine, ADR 0012), whose branch keeps its name. */
export async function isolate(project: string, id: string, p: Policy, from?: string): Promise<Isolated> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`not a run id: ${id}`);
  const base = from ?? await git(project, ["rev-parse", "--verify", "--quiet", `refs/heads/${p.devBranch}`]).then(
    () => p.devBranch,
    () => "HEAD",
  );
  const root = worktreesOf(project);
  const path = `${root}/agent-${id}`;
  const hooks = `${root}/agent-${id}.hooks`;
  const branch = `agent/${id}`;
  await Deno.mkdir(hooks, { recursive: true });
  await Deno.writeTextFile(`${hooks}/pre-push`, hookScript(p, id), { mode: 0o755 });
  await git(project, ["worktree", "add", from ? "-B" : "-b", branch, path, base]);
  await git(project, ["config", "extensions.worktreeConfig", "true"]);
  await git(path, ["config", "--worktree", "core.hooksPath", hooks]);
  return { path, branch, base, hooks };
}
