// runtime.ts — The runtime's folder and its `shared` link into the repository.

import { lstat, readlink } from "../../lib/fs.ts";
import { REPO, RUNTIME, shortHome } from "../../lib/paths.ts";
import { COPY_SHARED } from "../../lib/mode.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** The runtime's folder and its `shared` link into the repository. */
export async function runtimeChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
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
