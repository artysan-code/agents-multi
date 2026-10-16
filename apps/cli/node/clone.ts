// clone.ts — a repository cloned the first time a job or a resume needs it (ADR 0014, slice A). A node used to
// refuse a job whose repository it had no clone of; it now clones it, but only a remote the owner allowed: one of
// `repos` in config/nodes.json, or one under a host (or `host/owner`) of `gitHosts`. Any other remote — a client's,
// a stranger's — is refused with its reason. The clone is the node's own act: its own git key, no SSH agent, no
// credential helper, nothing from the environment; a clone that fails leaves nothing half made.

import { normalRemote } from "../../../shared/mcp/lib/nodes.ts";
import type { NodeConfig } from "../../../shared/mcp/lib/headless.ts";
import { findClone } from "../../../shared/mcp/lib/moving.ts";
import { HOME } from "../lib/paths.ts";

/** Pure: a clone's folder name from its remote (`git@host:me/repo.git` → `repo`). */
export function cloneName(remote: string): string {
  return remote.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() || "repo";
}

/** The remotes a node clones from: `ssh://`, `https://` or `user@host:path`. */
const URL_FORM = /^(ssh:\/\/|https:\/\/|[\w.-]+@[\w.-]+:(?!\/))/;

/** Pure: why a remote address may not be cloned as it is written, or null: another scheme, or credentials in it
 *  (`https://user:token@…`; a user alone, as in `ssh://git@…`, is no secret). */
export function badUrl(url: string): string | null {
  if (!URL_FORM.test(url)) return "not an ssh://, https:// or user@host: remote";
  if (/^https:\/\/[^/@]*@/.test(url)) return "credentials in the address";
  if (/^ssh:\/\/[^/@]*:[^/@]*@/.test(url)) return "credentials in the address";
  return null;
}

/** Pure: a normalised remote (`host[:port]/owner/repo`) split. */
export function splitRemote(remote: string): { host: string; port?: string; path: string[] } {
  const [hp, ...path] = normalRemote(remote).split("/");
  const [host, port] = hp.split(":");
  return { host, ...(port ? { port } : {}), path: path.filter(Boolean) };
}

/** Pure: whether a `gitHosts` entry covers a remote: the same host (and port when the entry names one), and the
 *  entry's owner as the remote's first folder. Never by substring: `git.example.me` does not cover
 *  `git.example.me.evil.org`, `github.com/me` does not cover `github.com/meme`. */
export function hostCovers(entry: string, remote: string): boolean {
  const e = splitRemote(entry), r = splitRemote(remote);
  if (!e.host || e.host !== r.host || (e.port && e.port !== r.port)) return false;
  if (r.path.length < 2) return false; // an owner and a repository at least
  return e.path.every((seg, i) => r.path[i] === seg);
}

export type Allowed = { ok: true; via: "repos" | "gitHosts"; url: string } | { ok: false; why: string };

/** Pure: whether the owner allowed this remote to be cloned on need, and the address to clone it from. `remote` is a
 *  job's (normalised, `git.example.me/owner/repo`) or an address; one of `repos` is cloned from the address the
 *  owner wrote there, one under `gitHosts` over SSH with the node's key (`ssh://git@host/owner/repo.git`) unless
 *  it came as an address of its own. */
export function remoteAllowed(cfg: Pick<NodeConfig, "repos" | "gitHosts">, remote: string): Allowed {
  const n = normalRemote(remote);
  const listed = cfg.repos.find((u) => normalRemote(u) === n);
  if (listed) {
    const bad = badUrl(listed);
    return bad ? { ok: false, why: `${listed} in repos: ${bad}` } : { ok: true, via: "repos", url: listed };
  }
  if (!(cfg.gitHosts ?? []).some((h) => hostCovers(h, n))) return { ok: false, why: "not in repos or gitHosts" };
  if (URL_FORM.test(remote) || remote.includes("://")) {
    const bad = badUrl(remote);
    return bad ? { ok: false, why: bad } : { ok: true, via: "gitHosts", url: remote };
  }
  const { host, port, path } = splitRemote(n);
  return { ok: true, via: "gitHosts", url: `ssh://git@${host}${port ? `:${port}` : ""}/${path.join("/")}.git` };
}

/** Pure: where a clone of `url` goes: under the first of `repoRoots`, by its name. */
export function cloneTarget(cfg: Pick<NodeConfig, "repoRoots">, url: string, home: string): string {
  const root = (cfg.repoRoots[0] ?? "~").replace(/^~(?=\/|$)/, home);
  return `${root.replace(/\/+$/, "")}/${cloneName(url)}`;
}

/** Pure: the environment git clones with: nothing of the caller's (no SSH agent, no token, no askpass), the node's
 *  key only, the forge's host key taken the first time it is seen (the node has no one to ask). */
export function cloneEnv(home: string, path: string): Record<string, string> {
  const key = `${home}/.ssh/id_ed25519`;
  return {
    HOME: home,
    PATH: path,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND:
      `ssh -i ${key} -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=accept-new`,
  };
}

export interface CloneOpts {
  home?: string;
  log?: (s: string) => void;
  notify?: (title: string, body: string) => void;
  /** after a clone is found or made: the env files seeded for it (seed.ts's `applySeeded` unless a test passes its
   *  own, or null for none) */
  seed?: ((dir: string, remote: string) => Promise<void>) | null;
  now?: () => number;
}

/** When the owner was last told of a failed clone, per remote: once an hour at most. */
const told = new Map<string, number>();
const HOUR = 3600_000;

async function git(args: string[], env: Record<string, string>): Promise<{ ok: boolean; err: string }> {
  const r = await new Deno.Command("git", { args, env, clearEnv: true, stdin: "null", stdout: "null", stderr: "piped" })
    .output().catch((e) => ({ success: false, stderr: new TextEncoder().encode((e as Error).message) }));
  return { ok: r.success, err: new TextDecoder().decode(r.stderr).trim().split("\n").pop() ?? "" };
}

/** The clone of `remote` this node works in: the one it has (under `repoRoots`), else one it makes when the owner
 *  allowed the remote; else why not. The env files seeded for it are written each time (seed.ts). */
export async function ensureClone(
  cfg: NodeConfig,
  remote: string,
  o: CloneOpts = {},
): Promise<{ dir: string; cloned: boolean } | { why: string }> {
  const home = o.home ?? HOME;
  const repo = normalRemote(remote);
  const log = o.log ?? (() => {});
  const apply = o.seed !== undefined
    ? o.seed
    : async (dir: string, r: string) => (await import("./seed.ts")).applySeeded(cfg, dir, r, log);
  const seed = async (dir: string) => {
    await apply?.(dir, repo).catch((e) => log(`node: seed of ${repo}: ${(e as Error).message}`));
  };
  const have = await findClone(repo, cfg.repoRoots, home);
  if (have) {
    await seed(have);
    return { dir: have, cloned: false };
  }
  const allowed = remoteAllowed(cfg, remote);
  if (!allowed.ok) return { why: `no clone of ${repo} under ${cfg.repoRoots.join(", ")}, ${allowed.why}` };
  const dir = cloneTarget(cfg, allowed.url, home);
  if (await Deno.lstat(dir).catch(() => null)) {
    return { why: `${dir} exists and is not a clone of ${repo}: move it, or clone ${repo} by hand` };
  }
  // into a sibling first: a clone that fails halfway is removed whole, and the target appears only once complete
  const parent = dir.slice(0, dir.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  const tmp = `${parent}/.${cloneName(allowed.url)}.cloning-${crypto.randomUUID().slice(0, 8)}`;
  const env = cloneEnv(home, Deno.env.get("PATH") ?? "/usr/bin:/bin");
  const r = await git(["-c", "credential.helper=", "clone", "--quiet", "--", allowed.url, tmp], env);
  if (!r.ok) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    const now = (o.now ?? Date.now)();
    if (now - (told.get(repo) ?? -Infinity) >= HOUR) {
      told.set(repo, now);
      o.notify?.(
        `A clone failed on this node`,
        `${repo}: ${r.err || "git clone failed"} (does the forge take its key?)`,
      );
    }
    return { why: `cloning ${repo} failed: ${r.err || "git clone failed"}` };
  }
  try {
    await Deno.rename(tmp, dir);
  } catch (e) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    return { why: `cloning ${repo}: ${(e as Error).message}` };
  }
  log(`node: cloned ${repo} into ${dir} (${allowed.via})`);
  await seed(dir);
  return { dir, cloned: true };
}

/** For a test: forget when the owner was told. */
export const resetTold = () => told.clear();
