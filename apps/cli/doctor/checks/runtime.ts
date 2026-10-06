// runtime.ts — The runtime `shared` link into the repository.

import { lstat, readlink } from "../../lib/fs.ts";
import { REPO, RUNTIME } from "../../lib/paths.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** The runtime `shared` link into the repository. */
export async function runtimeChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- runtime shared → repo
  const sharedLink = await readlink(`${RUNTIME}/shared`);
  if (sharedLink === `${REPO}/shared`) add("runtime.shared", "ok", "~/.claude-multi/shared → repository");
  else if (await lstat(`${RUNTIME}/shared`)) {
    add(
      "runtime.shared",
      "fail",
      `~/.claude-multi/shared does not point at the repository (${sharedLink ?? "real directory"})`,
      "claude-multi install",
    );
  } else add("runtime.shared", "fail", "~/.claude-multi/shared is missing", "claude-multi install");
  return c;
}
