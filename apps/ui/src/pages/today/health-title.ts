// health-title.ts — a short human title for a doctor's check, by its id: the doctor's own message is
// technical, and stays as the detail line. Ids carry names (a profile, a server, a component): the
// pattern takes the name out and the title puts it back. A check no pattern knows keeps its message.

import { type Key, t } from "../../i18n.ts";

/** id pattern → title key; the first group, when there is one, is the name the title shows as {x}. */
const TITLES: [RegExp, Key][] = [
  [/^mcp\.(sync|registry|legacy)$/, "hc.mcp.sync"],
  [/^mcp\.(.+)$/, "hc.mcp"],
  [/^login\.(.+)$/, "hc.login"],
  [/^profile\.([^.]+)\.(login|creds)$/, "hc.login"],
  [/^profile\.([^.]+)\.[^.]+\.extra$/, "hc.profile.extra"],
  [/^profile\.([^.]+)\.[^.]+\.missing$/, "hc.profile.missing"],
  [/^profile\.([^.]+)\.[^.]+\.broken$/, "hc.profile.broken"],
  [/^profile\.([^.]+)\.plugins(\.stale)?$/, "hc.profile.plugins"],
  [/^profile\.orphan$/, "hc.profile.orphan"],
  [/^profile\.([^.]+)/, "hc.profile"],
  [/^desktop\.(apt-key|shims|timer|urlhandler|userspace|entry\..+)$/, "hc.desktop.setup"],
  [/^desktop\.(.+)$/, "hc.desktop"],
  [/^desktop-rebuild$/, "hc.desktop.setup"],
  [/^repo\.dirty$/, "hc.repo.dirty"],
  [/^repo\.(upstream|sync)$/, "hc.repo.sync"],
  [/^repo\b/, "hc.repo"],
  [/^shared\.skills\.unlinked$/, "hc.skills.unlinked"],
  [/^shared\b/, "hc.shared"],
  [/^console\.ui$/, "hc.console.ui"],
  [/^console\b/, "hc.console"],
  [/^(config|vault)\.conflicts$/, "hc.conflicts"],
  [/^vault\b/, "hc.vault"],
  [/^brain\.backup$/, "hc.brain.backup"],
  [/^brain\b/, "hc.brain"],
  [/^tasks\b/, "hc.tasks"],
  [/^update\b/, "hc.update"],
  [/^app\b/, "hc.app"],
  [/^bin\b/, "hc.bin"],
  [/^(syncthing|stignore-gen)$/, "hc.syncthing"],
  [/^zshrc$/, "hc.zshrc"],
];

export function checkTitle(c: { id: string; msg: string }): string {
  for (const [re, key] of TITLES) {
    const m = re.exec(c.id);
    if (m) return t(key, { x: m[1] ?? "" });
  }
  return c.msg;
}
