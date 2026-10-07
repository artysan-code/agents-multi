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
/** Something the person does. */
export const userStep = (text: string): RepairStep => ({ kind: "user", text });
/** Re-run the check that offered the repair. */
export const verifyStep: RepairStep = { kind: "verify" };
