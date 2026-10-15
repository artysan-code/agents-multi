// platform.ts — the platform layer: the few operations that are tied to one operating system's tools,
// in one place. Linux is what the code was written on and keeps its exact commands; macOS and Windows get
// an implementation where one is reasonable, and a clear `Unsupported` error where it is not.
//
//   secretStore    the vault key in the OS keyring   secret-tool   |  security (Keychain)  |  unsupported
//   spawnDetached  a program that outlives its asker setsid -f     |  nohup                |  spawned, unref'd
//   listProcesses  every process: pid, parent, name  ps            |  ps                   |  PowerShell (CIM)
//   notify         a desktop notification            notify-send   |  osascript            |  PowerShell toast
//   openUrl        a link or a path in the default app xdg-open    |  open                 |  rundll32
//
// Lives in shared/mcp/lib so that both the CLI and the MCP servers (which run under a narrow Deno
// `--allow-run`) can import it. Every choice of command is a pure function of the platform name and is
// tested; the functions that run it are thin. Nothing here prints a secret.
//
// Not covered, on purpose: reading another process's /proc files (exe, cwd, environ, cmdline, start ticks),
// which `running()` in apps/cli/lib/processes.ts, the gateway and `agents ask` still do on Linux only.

export type Platform = "linux" | "darwin" | "windows";

/** The platform this runs on. Anything Deno does not call darwin or windows is treated as Linux. */
export const platformOf = (os: string = Deno.build.os): Platform =>
  os === "darwin" ? "darwin" : os === "windows" ? "windows" : "linux";

/** An operation this platform has no implementation for. */
export class Unsupported extends Error {
  constructor(what: string, platform: Platform = platformOf()) {
    super(`${what} is not supported on this platform (${platform})`);
  }
}

/** A command to run: the program and its arguments. */
export interface Cmd {
  cmd: string;
  args: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- secret store
/** What the OS keyring is asked for: a secret is found by `service` + `account`, and shown with `label`. */
export interface SecretKey {
  service: string;
  account: string;
}

/** Pure: the keyring's program on this platform; null where there is none. This is what a Deno
 *  `--allow-run` has to name for the vault, and what the deny rules in shared/settings.json keep a
 *  session away from (the doctor checks them). */
export function secretStoreBinary(p: Platform = platformOf()): string | null {
  return p === "linux" ? "/usr/bin/secret-tool" : p === "darwin" ? "/usr/bin/security" : null;
}

/** Pure: the command that reads a secret (printed on stdout). */
export function secretLookupCmd(k: SecretKey, p: Platform = platformOf()): Cmd {
  if (p === "linux") {
    return { cmd: "/usr/bin/secret-tool", args: ["lookup", "application", k.service, "kind", k.account] };
  }
  if (p === "darwin") {
    return { cmd: "/usr/bin/security", args: ["find-generic-password", "-s", k.service, "-a", k.account, "-w"] };
  }
  throw new Unsupported("the keyring", p);
}

/** Pure: the command that stores a secret, and the text it reads on stdin. macOS's `security` takes the
 *  value as an argument, which any process can read in the process list: its interactive mode reads
 *  the command from stdin instead. */
export function secretStoreCmd(
  k: SecretKey,
  label: string,
  value: string,
  p: Platform = platformOf(),
): Cmd & { stdin: string } {
  if (p === "linux") {
    return {
      cmd: "/usr/bin/secret-tool",
      args: ["store", `--label=${label}`, "application", k.service, "kind", k.account],
      stdin: value,
    };
  }
  if (p === "darwin") {
    const q = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
    return {
      cmd: "/usr/bin/security",
      args: ["-i"],
      stdin: `add-generic-password -U -s ${q(k.service)} -a ${q(k.account)} -l ${q(label)} -w ${q(value)}\n`,
    };
  }
  throw new Unsupported("the keyring", p);
}

async function runWith(c: Cmd, stdin?: string): Promise<{ code: number; out: string }> {
  const p = new Deno.Command(c.cmd, {
    args: c.args,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();
  if (stdin !== undefined) {
    const w = p.stdin.getWriter();
    await w.write(enc.encode(stdin));
    await w.close();
  }
  const r = await p.output();
  return { code: r.code, out: dec.decode(r.stdout).trim() };
}

/** The OS keyring. `lookup` is null when there is no such secret; both throw if the keyring cannot be
 *  reached (program missing, no session) or the platform has none (`Unsupported`). */
export const secretStore = {
  async lookup(k: SecretKey): Promise<string | null> {
    const r = await runWith(secretLookupCmd(k));
    return r.code === 0 && r.out ? r.out : null;
  },
  /** True when the keyring kept it. */
  async store(k: SecretKey, label: string, value: string): Promise<boolean> {
    const c = secretStoreCmd(k, label, value);
    return (await runWith(c, c.stdin)).code === 0;
  },
};

// ---------------------------------------------------------------- detached programs
/** Pure: how to start `cmd` so that it outlives whoever asked: its own session on Linux (`-f`: setsid
 *  returns at once), nohup on macOS (no setsid there), unchanged on Windows. `wait` says whether the
 *  launcher itself ends by itself (true) or stays as the program's parent and must only be let go (false). */
export function detachCmd(cmd: string, args: string[], p: Platform = platformOf()): Cmd & { wait: boolean } {
  if (p === "linux") return { cmd: "setsid", args: ["-f", cmd, ...args], wait: true };
  if (p === "darwin") return { cmd: "nohup", args: [cmd, ...args], wait: false };
  // Windows does not end a child with its parent, and `start`'s quoting does not survive Deno's: spawn it as is
  return { cmd, args, wait: false };
}

/** Starts a program detached from the caller (stdio closed). It does not wait for it to finish. */
export async function spawnDetached(
  cmd: string,
  args: string[],
  opts: { env?: Record<string, string> } = {},
): Promise<void> {
  const d = detachCmd(cmd, args);
  const c = new Deno.Command(d.cmd, { args: d.args, env: opts.env, stdin: "null", stdout: "null", stderr: "null" });
  if (d.wait) await c.output();
  else c.spawn().unref();
}

// ---------------------------------------------------------------- processes
/** A process as the hub names a coordinator: pid and start time (seconds since the epoch, as a string). */
export interface ProcInfo {
  ppid: number;
  comm: string;
  start: string;
}

/** Pure: `ps -A -o pid=,ppid=,stat=,lstart=,comm=` (LC_ALL=C; the same on Linux and macOS) as a table. A
 *  line it cannot read, and a zombie, are left out. */
export function parsePs(out: string): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (!m || m[3].startsWith("Z")) continue;
    const at = Date.parse(m[4]);
    if (!Number.isFinite(at)) continue;
    table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[5], start: String(Math.round(at / 1000)) });
  }
  return table;
}

/** The PowerShell line that lists the processes, one `pid,ppid,epoch-seconds,name` each. */
export const WIN_PS_LIST =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0},{1},{2},{3}' -f $_.ProcessId, $_.ParentProcessId, " +
  "[DateTimeOffset]::new($_.CreationDate).ToUnixTimeSeconds(), $_.Name }";

/** Pure: the Windows listing (see `WIN_PS_LIST`) as a table. A name may hold commas: it is the rest of the line. */
export function parseWinProcs(out: string): Map<number, ProcInfo> {
  const table = new Map<number, ProcInfo>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+),(\d+),(\d+),(.+?)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), { ppid: Number(m[2]), comm: m[4], start: m[3] });
  }
  return table;
}

/** Pure: the command that lists every process, and the parser of what it prints. */
export function listProcessesCmd(
  p: Platform = platformOf(),
): Cmd & { env?: Record<string, string>; parse: (out: string) => Map<number, ProcInfo> } {
  if (p === "windows") {
    return {
      cmd: "powershell",
      args: ["-NoProfile", "-NonInteractive", "-Command", WIN_PS_LIST],
      parse: parseWinProcs,
    };
  }
  return { cmd: "ps", args: ["-A", "-o", "pid=,ppid=,stat=,lstart=,comm="], env: { LC_ALL: "C" }, parse: parsePs };
}

/** Every process on the machine, keyed by pid. Synchronous: the hub asks it from a reader. */
export function listProcesses(): Map<number, ProcInfo> {
  const l = listProcessesCmd();
  const r = new Deno.Command(l.cmd, { args: l.args, env: l.env, stdout: "piped", stderr: "null" }).outputSync();
  if (!r.success) throw new Error(`\`${l.cmd}\` failed: cannot tell which processes are alive`);
  return l.parse(dec.decode(r.stdout));
}

/** Whether a process with this pid exists: /proc on Linux (no program to run), the process list elsewhere. */
export function pidAlive(pid: number): boolean {
  if (platformOf() === "linux") {
    try {
      Deno.statSync(`/proc/${pid}`);
      return true;
    } catch {
      return false;
    }
  }
  return listProcesses().has(pid);
}

// ---------------------------------------------------------------- notifications
/** The Windows toast: the text comes in the environment, never spliced into the script. */
export const WIN_TOAST =
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; " +
  "$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent('ToastText02'); " +
  "$t = $x.GetElementsByTagName('text'); " +
  "$t[0].AppendChild($x.CreateTextNode($env:AM_TITLE)) | Out-Null; " +
  "$t[1].AppendChild($x.CreateTextNode($env:AM_BODY)) | Out-Null; " +
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('agents-multi')" +
  ".Show([Windows.UI.Notifications.ToastNotification]::new($x))";

/** Who a notification says it is from (Linux): another tool than agents-multi names itself. */
export interface NotifyFrom {
  app?: string;
}

/** Pure: the command that shows a notification. Linux: normal urgency, eight seconds, never `-u critical`
 *  (KDE ignores its expiry). macOS: the text is the script's arguments, not part of its source. */
export function notifyCmd(
  title: string,
  body: string,
  p: Platform = platformOf(),
  from: NotifyFrom = {},
): Cmd & { env?: Record<string, string> } {
  if (p === "linux") {
    // a named sender is a plain notification of its own; the default one is agents-multi's (icon, urgency, expiry)
    if (from.app) return { cmd: "notify-send", args: ["-a", from.app, title, body] };
    return {
      cmd: "notify-send",
      args: ["-a", "agents-multi", "-i", "claude-desktop", "-u", "normal", "--expire-time=8000", title, body],
    };
  }
  if (p === "darwin") {
    return {
      cmd: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        title,
        body,
      ],
    };
  }
  return {
    cmd: "powershell",
    args: ["-NoProfile", "-NonInteractive", "-Command", WIN_TOAST],
    env: { AM_TITLE: title, AM_BODY: body },
  };
}

/** Shows a desktop notification. False when this machine cannot (no program, no session): never throws. */
export async function notify(title: string, body: string, from: NotifyFrom = {}): Promise<boolean> {
  const n = notifyCmd(title, body, platformOf(), from);
  try {
    const r = await new Deno.Command(n.cmd, { args: n.args, env: n.env, stdin: "null", stdout: "null", stderr: "null" })
      .output();
    return r.success;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- opening things
/** Pure: the command that opens a URL or a path in the default application. Windows goes through
 *  rundll32, not `start`: nothing in the target is read by a shell, so `&` in a query string is safe. */
export function openCmd(target: string, p: Platform = platformOf()): Cmd {
  if (p === "linux") return { cmd: "xdg-open", args: [target] };
  if (p === "darwin") return { cmd: "open", args: [target] };
  return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", target] };
}

/** Opens a URL or a path in the default application, without waiting. Throws when the program is missing:
 *  callers print the link as well, so they catch it. */
export function openUrl(target: string): void {
  const o = openCmd(target);
  new Deno.Command(o.cmd, { args: o.args, stdin: "null", stdout: "null", stderr: "null" }).spawn().unref();
}
