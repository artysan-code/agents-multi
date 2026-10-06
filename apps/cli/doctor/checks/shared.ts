// shared.ts — shared/: broken entries and skills installed but not mounted.

import { KINDS, sharedInventory } from "../../lib/profiles.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** shared/: broken entries and skills installed but not mounted. */
export async function sharedChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- shared: broken symlinks, skills installed but not mounted
  const inv = await sharedInventory();
  for (const k of KINDS) {
    const broken = Object.entries(inv[k]).filter(([, v]) => v.broken).map(([n]) => n);
    if (broken.length) {
      add(
        `shared.${k}.broken`,
        "fail",
        `shared/${k}: ${broken.length} broken entries (${broken.slice(0, 4).join(", ")}${
          broken.length > 4 ? "…" : ""
        })`,
        "claude-multi install, or remove the entry",
      );
    }
  }
  const unlinked = inv.agentsSkills.filter((s) => !(s in inv.skills));
  if (unlinked.length) {
    add(
      "shared.skills.unlinked",
      "warn",
      `skills in ~/.agents/skills are not mounted: ${unlinked.join(", ")}`,
      "claude-multi install, then commit; if they were removed on purpose, move them out of ~/.agents/skills instead",
    );
  }
  if (!Object.values(inv.skills).some((v) => v.broken)) {
    add(
      "shared.skills",
      "ok",
      `shared: ${Object.keys(inv.skills).length} skills · ${Object.keys(inv.agents).length} agents · ${
        Object.keys(inv.commands).length
      } commands · ${inv.hooks.length} hooks · ${inv.rules.length} rules`,
    );
  }
  return c;
}
