// logins.ts — Claude Code logins: recorded failures and, with --probe, one request each.

import { dayOf, hhmm } from "../../../../shared/mcp/lib/tasks.ts";
import { launchers } from "../../lib/profiles.ts";
import { loginFailures, probeLogin, recordLogin } from "../../login.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** Claude Code logins: recorded failures and, with --probe, one request each. */
export async function loginChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  // --- Claude Code logins: what the console's requests found, and with --probe one request each
  const failed = await loginFailures();
  if (ctx.probe) {
    const ls = await launchers();
    const verdicts = await Promise.all(ls.map(async (l) => ({ l, v: await probeLogin(l.command) })));
    for (const { l, v } of verdicts) {
      await recordLogin(l.profile, l.command, v.ok ? null : v.error ?? "error");
      if (v.ok) add(`login.${l.profile}`, "ok", `${l.profile}: Claude Code login works`);
      else {add(
          `login.${l.profile}`,
          "warn",
          `${l.profile}: Claude Code cannot sign in (${v.error})`,
          `${l.command}, then /login`,
        );}
    }
  } else {
    for (const [p, f] of Object.entries(failed)) {
      add(
        `login.${p}`,
        "warn",
        `${p}: Claude Code's login stopped working (${f.error}, ${dayOf(new Date(f.at))} ${hhmm(new Date(f.at))})`,
        `${f.command}, then /login`,
      );
    }
  }
  return c;
}
