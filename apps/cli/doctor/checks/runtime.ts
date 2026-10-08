// runtime.ts — The runtime's folder and its `shared` link into the repository.

import { lstat, readlink } from "../../lib/fs.ts";
import { HOME, REPO, RUNTIME, shortHome, XDG } from "../../lib/paths.ts";
import { LEGACY_RUNTIME_NAME, LEGACY_XDG_NAME, RUNTIME_NAME, XDG_NAME } from "../../lib/runtime-root.ts";
import { COPY_SHARED } from "../../lib/mode.ts";
import { type Check } from "../../lib/output.ts";
import { amEnv } from "../../../../shared/mcp/lib/env.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** Pure: where the runtime stands, from what ~/.agents-multi and ~/.claude-multi are. */
export function runtimeName(now: "dir" | "link-old" | "other" | null, old: "dir" | "link-new" | "other" | null): Check {
  const id = "runtime.name";
  if (now === "dir" && old === "dir") {
    return {
      id,
      status: "fail",
      msg: `~/${RUNTIME_NAME} and ~/${LEGACY_RUNTIME_NAME} are both folders`,
      fix: "merge them by hand",
    };
  }
  if (now === "dir") {
    return old === null || old === "link-new" ? { id, status: "ok", msg: `runtime ~/${RUNTIME_NAME}` } : {
      id,
      status: "warn",
      msg: `~/${LEGACY_RUNTIME_NAME} is not a link to ~/${RUNTIME_NAME}`,
      fix: `look at ~/${LEGACY_RUNTIME_NAME} by hand`,
    };
  }
  if (old === "dir" && (now === null || now === "link-old")) {
    return {
      id,
      status: "warn",
      msg: `the runtime is still ~/${LEGACY_RUNTIME_NAME}`,
      fix: "agents migrate, from a terminal with Claude closed",
    };
  }
  return { id, status: "fail", msg: `no runtime at ~/${RUNTIME_NAME}`, fix: "agents install" };
}

async function kind(path: string, target: string) {
  const st = await lstat(path);
  if (!st) return null;
  if (st.isSymlink) return [target, `${HOME}/${target}`].includes(await readlink(path) ?? "") ? "link" : "other";
  return st.isDirectory ? "dir" : "other";
}

/** The runtime's folder and its `shared` link into the repository. */
export async function runtimeChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  // --- the runtime's name: ~/.agents-multi, the old name a link to it (agents migrate)
  if (!amEnv("ROOT")) {
    const now = await kind(`${HOME}/${RUNTIME_NAME}`, LEGACY_RUNTIME_NAME);
    const old = await kind(`${HOME}/${LEGACY_RUNTIME_NAME}`, RUNTIME_NAME);
    const r = runtimeName(now === "link" ? "link-old" : now, old === "link" ? "link-new" : old);
    add(r.id, r.status, r.msg, r.fix);
  }
  // --- the XDG folders under the new name, the old one a link to it (moveXdgDirs, at every command)
  const stuck = [];
  for (const base of [XDG.cache, XDG.state, XDG.data]) {
    if ((await lstat(`${base}/${LEGACY_XDG_NAME}`))?.isDirectory) stuck.push(shortHome(`${base}/${LEGACY_XDG_NAME}`));
  }
  if (stuck.length) {
    add("runtime.xdg", "warn", `still under the old name: ${stuck.join(", ")}`, `move it to ${XDG_NAME} by hand`);
  } else add("runtime.xdg", "ok", `cache, state and data under ${XDG_NAME}`);
  // --- runtime shared → the installed code (ctx.installed), which need not be the running code (a
  // development checkout, the app's package: repo.running says so)
  const where = `${shortHome(RUNTIME)}/shared`;
  const sharedLink = await readlink(`${RUNTIME}/shared`);
  if (ctx.mode === "app") {
    if (sharedLink !== COPY_SHARED) {
      add(
        "runtime.shared",
        "fail",
        `${where} does not point at the app's copy (${sharedLink ?? "missing"})`,
        "agents install",
      );
    } else if (!(await lstat(`${ctx.installed}/apps/cli/main.ts`))) {
      add(
        "runtime.shared",
        "fail",
        `${where} → the app's copy, which is missing`,
        "start Agents Multi: it installs its code",
      );
    } else add("runtime.shared", "ok", `${where} → the app's copy (${await readlink(ctx.installed) ?? "?"})`);
    return c;
  }
  const installed = ctx.installed === REPO ? "repository" : `repository (${shortHome(ctx.installed)})`;
  if (sharedLink === `${ctx.installed}/shared` && (await lstat(`${ctx.installed}/apps/cli/main.ts`))) {
    add("runtime.shared", "ok", `${where} → ${installed}`);
  } else if (sharedLink === `${ctx.installed}/shared`) {
    add("runtime.shared", "fail", `${where} points at no repository (${sharedLink})`, "agents install");
  } else if (await lstat(`${RUNTIME}/shared`)) {
    add(
      "runtime.shared",
      "fail",
      `${where} does not point at the repository (${sharedLink ?? "real directory"})`,
      "agents install",
    );
  } else add("runtime.shared", "fail", `${where} is missing`, "agents install");
  return c;
}
