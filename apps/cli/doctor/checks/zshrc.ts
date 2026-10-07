// zshrc.ts — The agents-multi block in ~/.zshrc against the manifests.

import { readText } from "../../lib/fs.ts";
import { HOME } from "../../lib/paths.ts";
import { ZSH_BEGIN, ZSH_END, zshBlock } from "../../lib/shell.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/**
 * Pure: the agents-multi block (marker to marker) found in a .zshrc, or undefined when there is none.
 *
 * @param zsh the contents of ~/.zshrc
 */
export function zshBlockIn(zsh: string): string | undefined {
  return zsh.match(new RegExp(`${ZSH_BEGIN.replace(/[()]/g, "\\$&")}[\\s\\S]*?${ZSH_END}`))?.[0];
}

/** The agents-multi block in ~/.zshrc against the manifests. */
export async function zshrcChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- shell integration
  const zsh = await readText(`${HOME}/.zshrc`) ?? "";
  // Compared against the block the manifests produce, not just probed for a marker: that is what
  // catches a profile added or renamed since the last install, whose alias is still the old one.
  const wantBlock = await zshBlock();
  const haveBlock = zshBlockIn(zsh);
  if (!haveBlock) add("zshrc", "warn", "no agents-multi block in ~/.zshrc", "agents-multi install");
  else if (haveBlock !== wantBlock) {
    add("zshrc", "warn", "the agents-multi block in ~/.zshrc no longer matches the manifests", "agents-multi install");
  } else add("zshrc", "ok", "~/.zshrc block is current");
  return c;
}
