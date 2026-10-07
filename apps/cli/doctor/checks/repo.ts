// repo.ts — Repository: git state, hooks, and home folders written out in shared files.

import { lstat, readlink, readText } from "../../lib/fs.ts";
import { REPO, shortHome } from "../../lib/paths.ts";
import { run } from "../../lib/proc.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** Pure: the home folders written out in a text (/home/<name>), each once. */
export function writtenHomes(text: string): string[] {
  return [...new Set(text.match(/\/home\/[a-z_][\w.-]*/g) ?? [])];
}

/**
 * Pure: the note that the running code is not the installed repository (`DoctorCtx.installed`) — a
 * development checkout, or the desktop app's copy — or null when it is. Said once here, so the checks
 * of the installation's links compare them with the installed repository and stay quiet.
 */
export function runningFrom(repo: string, installed: string, isRepo: boolean): Check | null {
  if (repo === installed) return null;
  const what = isRepo ? "a development checkout" : "the desktop app's copy";
  return {
    id: "repo.running",
    status: "ok",
    msg: `running from ${what}: ${shortHome(repo)} (installed: ${shortHome(installed)})`,
  };
}

/** Repository: git state, hooks, and home folders written out in shared files. */
export async function repoChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { repo } = ctx;
  const note = runningFrom(REPO, ctx.installed, repo.isRepo);
  if (note) add(note.id, note.status, note.msg);
  // --- repository
  if (!repo.isRepo) add("repo", "fail", `${REPO} is not a git repository`, `git clone <your fork> ${shortHome(REPO)}`);
  else {
    if (!repo.upstream) {
      add(
        "repo.upstream",
        "warn",
        `branch ${repo.branch} has no upstream: sync is off`,
        `git -C ${shortHome(REPO)} push -u origin ${repo.branch}`,
      );
    } else if (repo.behind && repo.ahead) {
      add(
        "repo.sync",
        "fail",
        `repository diverged: ↓${repo.behind} ↑${repo.ahead}`,
        `git -C ${shortHome(REPO)} pull --rebase (by hand)`,
      );
    } else if (repo.behind) add("repo.sync", "warn", `config is ${repo.behind} commits behind`, "agents sync");
    else if (repo.ahead) {
      add("repo.sync", "warn", `${repo.ahead} local commits not pushed`, `git -C ${shortHome(REPO)} push`);
    } else add("repo.sync", "ok", `in sync with ${repo.upstream} (${repo.head})`);
    if (repo.dirty) {
      add(
        "repo.dirty",
        "warn",
        `${repo.dirty} uncommitted files: ${repo.dirtyFiles.slice(0, 3).map((f) => f.trim()).join(", ")}${
          repo.dirty > 3 ? "…" : ""
        }`,
        `git -C ${shortHome(REPO)} status`,
      );
    }
  }

  if (repo.isRepo && (await run("git", ["-C", REPO, "config", "--get", "core.hooksPath"])).out !== ".githooks") {
    add(
      "repo.hooks",
      "warn",
      "repository pre-commit is not active (secret guard + type check)",
      "agents install",
    );
  }

  // --- portability: what the repository carries is shared by everyone who uses it, so a home
  // folder written out (/home/<name>/…) breaks for anyone else: $HOME in shell commands, ~ in
  // CLAUDE.md imports, ${HOME} in servers.json (filled in by mcp sync)
  if (repo.isRepo) {
    const files = (await run("git", ["-C", REPO, "ls-files", "shared", "config.example"])).out.split("\n").filter((f) =>
      f && !/\.(lock|png|svg|woff2)$/.test(f)
    );
    const hits: string[] = [];
    for (const f of files) {
      // a symlink is read by its target: a broken one has no content, only the path it points to
      const text = (await lstat(`${REPO}/${f}`))?.isSymlink
        ? await readlink(`${REPO}/${f}`)
        : await readText(`${REPO}/${f}`);
      if (writtenHomes(text ?? "").length) hits.push(f);
    }
    if (hits.length) {
      add(
        "repo.homes",
        "warn",
        `home folder written out in ${hits.length} shared files: ${hits.slice(0, 3).join(", ")}${
          hits.length > 3 ? "…" : ""
        }`,
        "write $HOME (shell), ~ (CLAUDE.md imports) or ${HOME} (servers.json) instead",
      );
    } else add("repo.homes", "ok", "no home folder written out in the repository");
  }
  return c;
}
