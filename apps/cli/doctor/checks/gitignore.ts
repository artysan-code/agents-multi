// gitignore.ts — Git's global ignore carries the projects' binding file.

import { readText } from "../../lib/fs.ts";
import { GIT_IGNORED, gitGlobalIgnore, missingIgnores } from "../../lib/git.ts";
import { shortHome } from "../../lib/paths.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** Git's global ignore carries the projects' binding file. */
export async function gitIgnoreChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- git's global ignore: a project's .claude/claude-multi.json is never committed
  {
    const file = await gitGlobalIgnore();
    const miss = missingIgnores(await readText(file) ?? "", GIT_IGNORED);
    if (miss.length) {
      add(
        "git.ignore",
        "warn",
        `${shortHome(file)} does not ignore ${miss.join(", ")}: a project's binding could be committed`,
        "agents install",
      );
    } else add("git.ignore", "ok", "git ignores the projects' .claude/claude-multi.json everywhere");
  }
  return c;
}
