// shell.ts — The managed block of ~/.zshrc, written from the profile manifests.

import { RUNTIME } from "./paths.ts";
import { launchers } from "./profiles.ts";

export const ZSH_BEGIN = "# >>> claude-multi (multi-account) >>>";
export const ZSH_END = "# <<< claude-multi <<<";

/** The managed ~/.zshrc block, written from the manifests: launchers, their aliases, and the
 *  default profile — the one whose command is plain `claude`, falling back to the first declared. */
export async function zshBlock(): Promise<string> {
  const ls = await launchers();
  const def = ls.find((l) => l.command === "claude") ?? ls[0];
  const lines = ls.map((l) => `# \`${l.command}\`${l.alias ? ` (${l.alias})` : ""} = ${l.profile} profile`);
  const aliases = ls.filter((l) => l.alias).map((l) => `alias ${l.alias}='${l.command}'`);
  return [
    ZSH_BEGIN,
    "# Managed by `claude-multi install`: do not edit by hand.",
    ...lines,
    `export CLAUDE_CONFIG_DIR="\${CLAUDE_CONFIG_DIR:-${RUNTIME}/${def?.profile ?? ""}}"`,
    "export DISABLE_AUTOUPDATER=1",
    ...aliases,
    ZSH_END,
  ].join("\n");
}
