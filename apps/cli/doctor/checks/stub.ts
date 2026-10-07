// stub.ts — The read-only ~/.claude safety stub.

import { lstat, mode } from "../../lib/fs.ts";
import { HOME } from "../../lib/paths.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** The read-only ~/.claude safety stub. */
export async function stubChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  const stub = await lstat(`${HOME}/.claude`);
  if (!stub) add("stub", "warn", "~/.claude is missing (the safety stub)", "agents install");
  else if (!stub.isDirectory) {
    add("stub", "fail", "~/.claude is not a directory", "rm ~/.claude && agents install");
  } else if (mode(stub) !== "500") {
    add("stub", "fail", `~/.claude mode ${mode(stub)} (expected 500)`, "chmod 500 ~/.claude");
  } else add("stub", "ok", "~/.claude stub is read-only (500)");
  return c;
}
