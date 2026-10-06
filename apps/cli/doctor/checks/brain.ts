// brain.ts — The brain: token, tasks store, local copies and their timer.

import { keyRefused } from "./vault.ts";
import { loadAccounts } from "../../../../shared/mcp/lib/accounts.ts";
import { brainAccount } from "../../../../shared/mcp/lib/brain-tasks.ts";
import { dayOf, hhmm, tasksRoot } from "../../../../shared/mcp/lib/tasks.ts";
import { getSecret } from "../../../../shared/mcp/lib/vault.ts";
import { lastBackup } from "../../brain-backup.ts";
import { listDir } from "../../lib/fs.ts";
import { shortHome } from "../../lib/paths.ts";
import { run } from "../../lib/proc.ts";
import { probeAccount } from "../../vault.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** The brain: token, tasks store, local copies and their timer. */
export async function brainChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m } = ctx;
  if (m.desktopVersion) {
    // the tasks live in the brain when there is a brain account: old files left in place are a second list
    const ba = brainAccount(undefined, loadAccounts());
    if (ba) {
      // the token this machine's tasks, console and copies use: one request says whether the brain still takes it
      const token = await getSecret("brain", ba.name).catch(() => null);
      const login = "claude-multi brain-login (or console › Connections › Sign in)";
      if (!token) {
        add(
          "brain.token",
          "warn",
          `no token for the brain (${ba.url}) on this machine: tasks and copies cannot reach it`,
          login,
        );
      } else {
        const p = await probeAccount(ba, token);
        if (p.ok) add("brain.token", "ok", `brain: ${ba.url} takes this machine's token`);
        else if (keyRefused(p.detail)) {
          add(
            "brain.token",
            "fail",
            `the brain refuses the token in the vault (${p.detail}): revoked, or made for another account`,
            login,
          );
        } else {add(
            "brain.token",
            "warn",
            `the brain at ${ba.url} did not answer (${p.detail})`,
            `curl -s ${ba.url}/health`,
          );}
      }
      const left = (await listDir(`${tasksRoot()}/items`)).filter((n) => /^t-[\w-]+\.md$/.test(n));
      if (left.length) {
        add(
          "tasks.migrate",
          "warn",
          `${left.length} tasks are still files in ${shortHome(tasksRoot())}/items, not in the brain`,
          "claude-multi tasks migrate",
        );
      } else add("tasks.store", "ok", "tasks: in the brain");
      // a copy of the brain on this machine: the server's volume is the only other one
      const b = await lastBackup();
      if (!b) add("brain.backup", "warn", "no copy of the brain on this machine yet", "claude-multi brain-backup");
      else if (!b.verified) {
        add(
          "brain.backup",
          "warn",
          `brain copies are kept (${b.file}) but not checked: the backup key is not in this vault`,
          "claude-multi brain-login (or console › Connections › Sign in): it brings the backup key too",
        );
      } else {add(
          "brain.backup",
          "ok",
          `brain: last copy ${b.file}, checked ${dayOf(new Date(b.checked))} ${hhmm(new Date(b.checked))}`,
        );}
      if (
        m.systemd && (await run("systemctl", ["--user", "is-enabled", "claude-brain-backup.timer"])).out !== "enabled"
      ) {
        add(
          "brain.timer",
          "warn",
          "claude-brain-backup.timer is not enabled: no copies of the brain here",
          "claude-multi install",
        );
      }
    }
  }
  return c;
}
