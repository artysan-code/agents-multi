// repo.ts — The installed code. In dev mode the repository: git state, hooks, and home folders written
// out in shared files. In app mode the app's copy: whether the app, its copy and its install agree.

import { type Build, buildId, readBuild } from "../../appcopy.ts";
import { type AppBuild, type InstallRecord, readAppBuild, readRecord } from "../../lib/appstate.ts";
import { lstat, readlink, readText } from "../../lib/fs.ts";
import { REPO, shortHome } from "../../lib/paths.ts";
import { installWaiting } from "../../selfupdate.ts";
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
  const what = isRepo ? "a development checkout" : "the desktop app's package";
  return {
    id: "repo.running",
    status: "ok",
    msg: `running from ${what}: ${shortHome(repo)} (installed: ${shortHome(installed)})`,
  };
}

/**
 * Pure: app mode's checks in place of the repository's — the build the app carries (what it wrote at
 * its last start), its copy in the runtime, and the last `install --app` (its record, and an install
 * left waiting for Claude to be closed). The launchers are the binaries group's, against the copy.
 */
export function appCodeChecks(
  f: { app: AppBuild | null; copy: Build | null; record: InstallRecord | null; waiting: boolean },
): Check[] {
  const out: Check[] = [];
  const add = (id: string, status: Check["status"], msg: string, fix?: string) => out.push({ id, status, msg, fix });
  if (f.record && !f.record.ok) {
    add("app.install", "fail", `the app's install failed: ${f.record.error ?? "no reason recorded"}`, "agents install");
  } else if (f.waiting) {
    add(
      "app.install",
      "warn",
      "the app's code is new, and install waits for every Claude to be closed",
      "close Claude, then agents self-update --settle (the console's «Close Claude and update»)",
    );
  }
  if (!f.copy) {
    add(
      "app.copy",
      "fail",
      "no copy of the app's code in ~/.agents-multi/app/current",
      "start Agents Multi: it installs its code",
    );
    return out;
  }
  const copy = buildId(f.copy);
  if (!f.app) add("app.version", "warn", `the copy is ${copy}, and the app has not started here`, "start Agents Multi");
  else if (f.app.build !== copy) {
    add(
      "app.version",
      "warn",
      `the app carries ${f.app.build}, its copy is ${copy}`,
      "restart Agents Multi: it installs its code when it starts",
    );
  } else add("app.version", "ok", `the app and its copy agree: ${copy}`);
  return out;
}

/** The installed code: the repository (dev) or the app's copy (app). */
export async function repoChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { repo } = ctx;
  // the installed code through its links (the app's copy is reached through app/current)
  const installed = await Deno.realPath(ctx.installed).catch(() => ctx.installed);
  const note = runningFrom(REPO, installed, repo.isRepo);
  if (note) add(note.id, note.status, note.msg);
  const record = await readRecord();
  if (ctx.mode === "app") {
    const checks = appCodeChecks({
      app: await readAppBuild(),
      copy: await readBuild(ctx.installed),
      record,
      waiting: !!(await installWaiting()),
    });
    for (const k of checks) add(k.id, k.status, k.msg, k.fix);
    return c;
  }
  // the app installed on a machine still on a checkout: its install refused, and says why
  if (record && !record.ok) {
    add("app.install", "warn", record.error ?? "the app's install was refused", "agents migrate app");
  }
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
