// repair.ts — the steps a check offers for its guided repair (Check.repair). The console walks them
// through; every action is a name of its own allowlist (console/actions.ts), validated again on the server.

import { type RepairStep } from "../lib/output.ts";
import { manualCommand, type Params } from "../console/actions.ts";

/** A console action, with the command that does the same by hand. */
export const actionStep = (action: string, args?: Params): RepairStep => ({
  kind: "action",
  action,
  ...(args ? { args } : {}),
  cmd: manualCommand(action, args),
});
/** Close the Claudes of these surfaces (`cli:<profile>`, `desktop:<profile>`) before the MCP sync. */
export const closeStep = (keys: string[]): RepairStep => ({
  kind: "close",
  for: "mcp",
  text: `Close the Claude sessions and Desktop windows of ${keys.join(", ")}`,
});
/** Close Claude Desktop — one profile's, or every one — before its files are replaced. */
export const closeDesktopStep = (profile?: string): RepairStep => ({
  kind: "close",
  for: profile ? `desktop:${profile}` : "desktop",
  text: profile ? `Close Claude Desktop (${profile})` : "Close every Claude Desktop",
});
/** Every Claude closed for the install a round left waiting (the console's «Close Claude and update»). */
export const closeForInstallStep: RepairStep = {
  kind: "close",
  for: "install",
  text: "Close every Claude session and Desktop window",
};
/** A profile's sign-in, in a terminal the console opens (`cmd` is its launcher, for doing it by hand). */
export const loginStep = (profile: string, cmd: string): RepairStep => ({
  kind: "login",
  profile,
  text: `Open a terminal, run ${cmd}, then type /login and finish the sign-in`,
});
/** Re-run the check that offered the repair. */
export const verifyStep: RepairStep = { kind: "verify" };
/** `agents install`, then the check again. */
export const installRepair: RepairStep[] = [actionStep("install"), verifyStep];
