// processes.ts — Running Claude Code and Claude Desktop instances, read from /proc (Linux only: `running()`
// says so elsewhere, through the platform layer).

import { readJson, stat } from "./fs.ts";
import { RUNTIME } from "./paths.ts";
import { run } from "./proc.ts";
import { requireLinux } from "../../../shared/mcp/lib/platform.ts";
import { launchers, type Profile } from "./profiles.ts";

// Classified by real executable (/proc/<pid>/exe), not by command line: a shell whose snapshot
// mentions "claude/versions" is not a session. /proc is read through readlink/cat (--allow-run)
// because Deno without --allow-all refuses to read /proc/<pid>/* directly.
async function procInfo(pid: number) {
  const [exeR, cwdR, envR] = await Promise.all([
    run("readlink", [`/proc/${pid}/exe`]),
    run("readlink", [`/proc/${pid}/cwd`]),
    run("cat", [`/proc/${pid}/environ`]),
  ]);
  const exe = exeR.out || null, cwd = cwdR.out || null, env = envR.out;
  const m = env.split("\0").find((e) => e.startsWith("CLAUDE_CONFIG_DIR="));
  const profile = m ? m.slice("CLAUDE_CONFIG_DIR=".length).split("/").pop() ?? null : null;
  return { exe, cwd, profile };
}
export interface CliProc {
  pid: number;
  profile: string | null;
  cwd: string | null;
  embedded: boolean;
  version: string | null;
  /** Session id and model, parsed off the command line. Several sessions of the same profile look
   *  identical without them — which is exactly what Desktop does when you open a few tabs. */
  session: string | null;
  model: string | null;
  /** When the session's transcript was last written: a running process is not a working one. */
  lastActivity: string | null;
}

/** Claude Code stores a session at projects/<cwd with slashes turned into dashes>/<id>.jsonl, so
 *  the transcript can be addressed directly from what the process tells us — no directory walk. */
function transcriptPath(profile: string, cwd: string | null, session: string | null) {
  if (!cwd || !session) return null;
  return `${RUNTIME}/${profile}/projects/${cwd.replace(/\//g, "-")}/${session}.jsonl`;
}
/** Pure: the Desktop variant an executable serves — the default build in user space
 *  (~/.local/lib/claude-desktop/versions/<v>/claude-desktop) is the default profile, a rebuilt one
 *  (~/.local/lib/claude-desktop-<p>/claude-desktop-<p>) names its profile; null for anything else. */
export function desktopVariantOf(exe: string, defaultProfile: string): string | null {
  const m = exe.match(/\/claude-desktop(?:-([a-z0-9-]+))?\/(?:versions\/[0-9.]+\/)?claude-desktop(?:-[a-z0-9-]+)?$/);
  return m ? m[1] ?? defaultProfile : null;
}
export async function running() {
  requireLinux("listing the Claude sessions and apps that are open (it reads their /proc)");
  const cli: CliProc[] = [];
  const ls = await launchers();
  const def = (ls.find((l) => l.command === "claude") ?? ls[0])?.profile ?? "default";
  const desktop: { pid: number; variant: Profile }[] = [];
  // Desktop binaries are named after the profile they serve (claude-desktop, claude-desktop-work…),
  // so the profile is read back off the executable path rather than a fixed table.
  // the launcher runs the native build through ~/.local/bin/claude-bin, a symlink: its command line
  // names the link, not claude/versions/ (the exe check below is what decides)
  const pg = await run("pgrep", [
    "-af",
    "claude/versions/|/claude-bin( |$)|/claude-code/[0-9.]+/claude |claude-desktop[a-z-]*/(versions/[0-9.]+/)?claude-desktop",
  ]);
  // one process's reads do not wait for another's; the lines keep their order in the result
  const found = await Promise.all(
    pg.out.split("\n").filter(Boolean).map(async (line) => {
      const [pidS, ...rest] = line.split(" ");
      const pid = Number(pidS);
      const cmd = rest.join(" ");
      if (cmd.includes("--type=")) return null; // Electron child processes
      return { pid, cmd, ...await procInfo(pid) };
    }),
  );
  for (const f of found) {
    if (!f?.exe) continue;
    const { pid, cmd, exe, cwd, profile } = f;
    const embedded = exe.match(/\/claude-code\/([0-9.]+)\/claude$/);
    const native = exe.match(/claude\/versions\/([0-9.]+)$/);
    if (embedded || native) {
      // a new session has no --resume: Claude Code records it in <config>/sessions/<pid>.json
      const session = cmd.match(/--resume[= ]([0-9a-f-]{36})/)?.[1] ??
        (profile
          ? (await readJson<{ sessionId?: string }>(`${RUNTIME}/${profile}/sessions/${pid}.json`))?.sessionId ?? null
          : null);
      const tp = profile ? transcriptPath(profile, cwd, session) : null;
      const st = tp ? await stat(tp) : null;
      cli.push({
        pid,
        profile,
        cwd,
        embedded: !!embedded,
        version: (embedded ?? native)![1],
        session,
        model: cmd.match(/--model[= ]([\w.-]+)/)?.[1] ?? null,
        lastActivity: st?.mtime?.toISOString() ?? null,
      });
      continue;
    }
    const variant = desktopVariantOf(exe, def);
    if (variant) desktop.push({ pid, variant });
  }
  return { cli, desktop };
}
