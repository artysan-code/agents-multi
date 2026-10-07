// syncthing.ts — Syncthing: the runtime is not a folder, and stignore-gen keeps git repositories out.

import { lstat } from "../../lib/fs.ts";
import { RUNTIME, shortHome, STIGNORE_GEN_TEMPLATE, SYNCTHING_CONFIG } from "../../lib/paths.ts";
import { run } from "../../lib/proc.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** Syncthing: the runtime is not a folder, and stignore-gen keeps git repositories out. */
export async function syncthingChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m } = ctx;
  // --- Syncthing: the agents-multi folder must not exist any more (config travels through git)
  if (await lstat(`${RUNTIME}/.stfolder`)) {
    add(
      "syncthing",
      "warn",
      `${shortHome(RUNTIME)} is still a Syncthing folder`,
      "remove the agents-multi folder from Syncthing",
    );
  }

  // --- Syncthing: stignore-gen keeps the git repositories out (post-checkout hook on clone + timer)
  if (await lstat(SYNCTHING_CONFIG)) {
    const tpl = (await run("git", ["config", "--global", "--get", "init.templateDir"])).out;
    const timer = m.systemd ? (await run("systemctl", ["--user", "is-enabled", "stignore-gen.timer"])).out : "enabled";
    if (tpl !== STIGNORE_GEN_TEMPLATE) {
      add(
        "stignore-gen",
        "warn",
        `git init.templateDir is ${tpl || "unset"}: a clone inside a Syncthing folder waits for the timer`,
        "agents install",
      );
    } else if (timer !== "enabled") {
      add("stignore-gen", "warn", `stignore-gen.timer: ${timer || "not installed"}`, "agents install");
    } else {add(
        "stignore-gen",
        "ok",
        "stignore-gen: git repositories kept out of Syncthing (hook on clone, timer every 15 min)",
      );}
  }
  return c;
}
