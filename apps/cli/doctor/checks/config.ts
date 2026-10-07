// config.ts — The person's configuration folder and its Syncthing conflict copies.

import { listDir, lstat, readlink, stat } from "../../lib/fs.ts";
import { CONFIG, shortHome } from "../../lib/paths.ts";
import { profileNames } from "../../lib/profiles.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** The Syncthing conflict copies (name.sync-conflict-…) under a folder, as paths relative to it. */
export async function syncConflicts(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const n of await listDir(`${root}/${rel}`)) {
    const r = rel ? `${rel}/${n}` : n;
    if (n.includes(".sync-conflict-")) out.push(r);
    else if ((await lstat(`${root}/${r}`))?.isDirectory && !n.startsWith(".")) {
      out.push(...await syncConflicts(root, r));
    }
  }
  return out;
}

/** The person's configuration folder and its Syncthing conflict copies. */
export async function configChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- the person's configuration: a folder of theirs that ~/.claude-multi/config links to,
  // usually kept in step between machines by Syncthing, which leaves a copy when two edits collide
  const cfgLink = await readlink(CONFIG);
  if (!(await stat(`${CONFIG}/owner.json`))) {
    add(
      "config",
      "fail",
      `no configuration at ${shortHome(CONFIG)}${cfgLink ? ` (it links to ${shortHome(cfgLink)})` : ""}`,
      "agents-multi init <folder>, or link your configuration folder there",
    );
  } else {
    add(
      "config",
      "ok",
      `configuration ${cfgLink ? shortHome(cfgLink) : shortHome(CONFIG)}: ${(await profileNames()).length} profiles`,
    );
    const conflicts = await syncConflicts(CONFIG);
    if (conflicts.length) {
      add(
        "config.conflicts",
        "warn",
        `${conflicts.length} Syncthing conflict copies in the configuration: ${conflicts.slice(0, 3).join(", ")}`,
        "compare each with its original, keep one, delete the copy",
      );
    }
  }
  return c;
}
