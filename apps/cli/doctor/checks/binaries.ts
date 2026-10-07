// binaries.ts — Launchers and wrappers in ~/.local/bin, jq, and the Claude Code binary.

import { listDir, lstat, readlink } from "../../lib/fs.ts";
import { BIN } from "../../lib/paths.ts";
import { has } from "../../lib/proc.ts";
import { launchers } from "../../lib/profiles.ts";
import { type Check } from "../../lib/output.ts";
import { checkList, type DoctorCtx } from "../context.ts";

/** Launchers and wrappers in ~/.local/bin, jq, and the Claude Code binary. */
export async function binariesChecks(ctx: DoctorCtx): Promise<Check[]> {
  const [c, add] = checkList();
  const { m } = ctx;
  // --- binaries and wrappers: links into the installed repository, which need not be the running code
  const repo = ctx.installed;
  const claudeLink = await readlink(`${BIN}/claude`);
  if (claudeLink === `${repo}/bin/claude`) {
    add("bin.claude", "ok", `~/.local/bin/claude → the ${ctx.mode === "app" ? "app's" : "repository's"} launcher`);
  } else if (claudeLink?.includes("claude/versions/")) {
    add(
      "bin.claude",
      "fail",
      "~/.local/bin/claude is the native updater's symlink: `claude` would start on the wrong profile",
      "agents install",
    );
  } else {add(
      "bin.claude",
      "fail",
      `~/.local/bin/claude → ${claudeLink ?? "a real file, or missing"}`,
      "agents install",
    );}
  // Every wrapper the repository ships, plus one launcher per profile pointed at bin/claude —
  // both lists come from what is there, so a new profile or script needs no edit here.
  for (const b of await listDir(`${repo}/bin`)) {
    if (b === "lib" || b === "claude") continue;
    if ((await readlink(`${BIN}/${b}`)) !== `${repo}/bin/${b}`) {
      add(`bin.${b}`, "fail", `~/.local/bin/${b} does not point at the repository`, "agents install");
    }
  }
  const missingLaunchers = [];
  for (const l of await launchers()) {
    if (l.command === "claude") continue; // covered by bin.claude above
    if ((await readlink(`${BIN}/${l.command}`)) !== `${repo}/bin/claude`) {
      missingLaunchers.push(`${l.command} (${l.profile})`);
    }
  }
  if (missingLaunchers.length) {
    add(
      "bin.launchers",
      "fail",
      `launchers not pointing at the repository: ${missingLaunchers.join(", ")}`,
      "agents install",
    );
  } else {add(
      "bin.launchers",
      "ok",
      `launchers: ${(await launchers()).map((l) => `${l.command} (${l.profile})`).join(" · ")}`,
    );}
  // The PreToolUse guards in shared/hooks read their payload with jq. Without it they fall back
  // to a sed parser (shared/hooks/lib/guard.sh), which is coarser: jq is a requirement.
  if (await has("jq")) add("bin.jq", "ok", "jq: the hooks parse their payload with it");
  else {
    add(
      "bin.jq",
      "fail",
      "jq is not installed: the guard hooks (vault, destructive commands, memory) fall back to a coarse parser",
      "install jq with the system package manager (pacman -S jq, apt install jq, dnf install jq)",
    );
  }
  if (await lstat(`${BIN}/claude-multi-finalize`)) {
    add(
      "bin.finalize",
      "warn",
      "claude-multi-finalize is superseded by `agents doctor`",
      `rm ${BIN}/claude-multi-finalize`,
    );
  }
  if (!m.cliVersion) add("bin.claude-bin", "fail", "claude-bin resolves to no version", "agents update --cli");
  else {
    add(
      "bin.claude-bin",
      m.cliVersions.length > 2 ? "warn" : "ok",
      `Claude Code ${m.cliVersion}${
        m.cliVersions.length > 1 ? ` (+${m.cliVersions.length - 1} cached, rollback available)` : ""
      }`,
      m.cliVersions.length > 2 ? "agents update --cli (prunes past N-1)" : undefined,
    );
  }
  return c;
}
