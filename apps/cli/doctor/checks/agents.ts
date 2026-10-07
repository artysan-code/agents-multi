// agents.ts — The external skills folder.

import { lstat } from "../../lib/fs.ts";
import { AGENTS_SKILLS } from "../../lib/paths.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** The external skills folder. */
export async function agentsChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  if (!(await lstat(AGENTS_SKILLS))) {
    add(
      "agents.dir",
      "warn",
      "~/.agents/skills is missing: external skills are unavailable on this machine",
      "agents install creates it",
    );
  }
  return c;
}
