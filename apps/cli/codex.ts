// codex.ts — `agents codex <profile> [args…]`: the Codex CLI with a profile's account, so a login or a
// session never touches another profile's (or the machine's own `~/.codex`). `agents codex limits
// <profile>` prints what the account's session logs say about its usage windows.

import { codexBin, codexHome, ensureCodexHome, readCodexLimits } from "../../shared/mcp/lib/codex.ts";
import { RUNTIME } from "./lib/paths.ts";
import { loadManifest, profileNames } from "./lib/profiles.ts";

const USAGE =
  `agents codex <profile> [codex args…]   Codex with that profile's account (login: agents codex <profile> login)
agents codex limits <profile>           the account's usage windows, from its session logs`;

export async function codexCommand(args: string[]): Promise<number> {
  const limits = args[0] === "limits";
  const profile = limits ? args[1] : args[0];
  if (!profile) {
    console.log(USAGE);
    return 2;
  }
  if (!(await profileNames()).includes(profile)) {
    console.error(`no profile ${profile}`);
    return 1;
  }
  if (!(await loadManifest(profile)).codex) {
    console.error(`profile ${profile} has no Codex account: set "codex": true in its profile.json`);
    return 1;
  }
  const home = codexHome(RUNTIME, profile);
  if (limits) {
    const l = await readCodexLimits(home);
    console.log(l ? JSON.stringify(l, null, 2) : "no reading yet: the account has not run a turn");
    return l ? 0 : 1;
  }
  const bin = codexBin(RUNTIME);
  if (!(await Deno.stat(bin).catch(() => null))) {
    console.error("Codex is not installed: agents update --codex");
    return 1;
  }
  await ensureCodexHome(home);
  const p = new Deno.Command(bin, {
    args: args.slice(1),
    env: { CODEX_HOME: home },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await p.output()).code;
}
