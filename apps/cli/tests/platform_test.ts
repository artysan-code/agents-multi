// Tests for the platform layer (shared/mcp/lib/platform.ts): which command each platform runs, and the
// parsing of what the process listings print. All pure: nothing is started.
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  detachCmd,
  listProcessesCmd,
  notifyCmd,
  openCmd,
  parentFromStat,
  parseEtimes,
  parsePs,
  parseWinProcs,
  platformOf,
  requireLinux,
  secretLookupCmd,
  secretStoreBinary,
  secretStoreCmd,
  startTimeOf,
  Unsupported,
  WIN_TOAST,
} from "../../../shared/mcp/lib/platform.ts";

const KEY = { service: "claude-multi", account: "vault-key" };

Deno.test("platformOf: darwin and windows by name, everything else is Linux", () => {
  assertEquals(platformOf("darwin"), "darwin");
  assertEquals(platformOf("windows"), "windows");
  assertEquals(platformOf("linux"), "linux");
  assertEquals(platformOf("freebsd"), "linux");
});

Deno.test("secret store: Linux keeps its exact secret-tool attributes", () => {
  assertEquals(secretStoreBinary("linux"), "/usr/bin/secret-tool");
  assertEquals(secretLookupCmd(KEY, "linux"), {
    cmd: "/usr/bin/secret-tool",
    args: ["lookup", "application", "claude-multi", "kind", "vault-key"],
  });
  assertEquals(secretStoreCmd(KEY, "agents vault key", "S3CRET", "linux"), {
    cmd: "/usr/bin/secret-tool",
    args: ["store", "--label=agents vault key", "application", "claude-multi", "kind", "vault-key"],
    stdin: "S3CRET",
  });
});

Deno.test("secret store: macOS reads with security and writes through its stdin, never an argument", () => {
  assertEquals(secretStoreBinary("darwin"), "/usr/bin/security");
  assertEquals(secretLookupCmd(KEY, "darwin").args, [
    "find-generic-password",
    "-s",
    "claude-multi",
    "-a",
    "vault-key",
    "-w",
  ]);
  const c = secretStoreCmd(KEY, "agents vault key", 'a"b\\c', "darwin");
  assertEquals(c.args, ["-i"]);
  assertEquals(c.args.some((a) => a.includes("b")), false);
  assertEquals(
    c.stdin,
    'add-generic-password -U -s "claude-multi" -a "vault-key" -l "agents vault key" -w "a\\"b\\\\c"\n',
  );
});

Deno.test("secret store: Windows has none, and says so", () => {
  assertEquals(secretStoreBinary("windows"), null);
  assertThrows(() => secretLookupCmd(KEY, "windows"), Unsupported, "not supported on this platform (windows)");
  assertThrows(() => secretStoreCmd(KEY, "l", "v", "windows"), Unsupported);
});

Deno.test("detachCmd: setsid -f on Linux, nohup on macOS, as is on Windows", () => {
  assertEquals(detachCmd("bash", ["-c", "x"], "linux"), { cmd: "setsid", args: ["-f", "bash", "-c", "x"], wait: true });
  assertEquals(detachCmd("bash", ["-c", "x"], "darwin"), { cmd: "nohup", args: ["bash", "-c", "x"], wait: false });
  assertEquals(detachCmd("agents.exe", ["run"], "windows"), { cmd: "agents.exe", args: ["run"], wait: false });
});

Deno.test("openCmd: the target is one argument, never read by a shell", () => {
  const url = "http://127.0.0.1:1/?a=1&b=2";
  assertEquals(openCmd(url, "linux"), { cmd: "xdg-open", args: [url] });
  assertEquals(openCmd(url, "darwin"), { cmd: "open", args: [url] });
  assertEquals(openCmd(url, "windows"), { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] });
});

Deno.test("notifyCmd: Linux is agents-multi's normal eight-second one, a named sender is plain", () => {
  assertEquals(notifyCmd("T", "B", "linux"), {
    cmd: "notify-send",
    args: ["-a", "agents-multi", "-i", "claude-desktop", "-u", "normal", "--expire-time=8000", "T", "B"],
  });
  assertEquals(notifyCmd("T", "B", "linux", { app: "Syncthing" }).args, ["-a", "Syncthing", "T", "B"]);
});

Deno.test("notifyCmd: the text never enters a script's source", () => {
  const evil = `x" & calc & '`;
  const mac = notifyCmd(evil, evil, "darwin");
  assertEquals(mac.cmd, "osascript");
  assertEquals(mac.args.slice(-2), [evil, evil]);
  assertEquals(mac.args.filter((a) => a.includes("calc")).length, 2); // only as the two trailing arguments
  const win = notifyCmd(evil, "body", "windows");
  assertEquals(win.env, { AM_TITLE: evil, AM_BODY: "body" });
  assertEquals(win.args.at(-1), WIN_TOAST);
  assertEquals(win.args.some((a) => a.includes("calc")), false);
});

Deno.test("listProcessesCmd: ps with a fixed locale off Windows, PowerShell on it", () => {
  const l = listProcessesCmd("linux");
  assertEquals([l.cmd, l.env], ["ps", { LC_ALL: "C" }]);
  assertEquals(listProcessesCmd("darwin").cmd, "ps");
  assertEquals(listProcessesCmd("windows").cmd, "powershell");
});

Deno.test("parsePs: the same table from macOS output (comm is a path there)", () => {
  const out = [
    "    1     0 Ss   Thu Oct 15 08:00:00 2026 /sbin/launchd",
    "  420     1 S    Thu Oct 15 09:30:12 2026 /Applications/Claude.app/Contents/MacOS/Claude",
    "  421   420 Z    Thu Oct 15 09:30:13 2026 (defunct)",
  ].join("\n");
  const t = parsePs(out);
  assertEquals(t.size, 2);
  assertEquals(t.get(420)?.ppid, 1);
  assertEquals(t.get(420)?.comm, "/Applications/Claude.app/Contents/MacOS/Claude");
  assertEquals(t.has(421), false);
});

Deno.test("parseWinProcs: pid,ppid,epoch,name; a name may hold commas; junk is skipped", () => {
  const out = "4,0,1760000000,System\r\n812,4,1760000100,claude.exe\r\nnoise\r\n900,812,1760000200,a,b.exe\r\n";
  const t = parseWinProcs(out);
  assertEquals(t.size, 3);
  assertEquals(t.get(812), { ppid: 4, comm: "claude.exe", start: "1760000100" });
  assertEquals(t.get(900)?.comm, "a,b.exe");
});

Deno.test("requireLinux: passes on Linux, says what is not supported elsewhere", () => {
  requireLinux("reading /proc", "linux");
  assertThrows(() => requireLinux("reading /proc", "darwin"), Unsupported, "reading /proc is not supported");
  assertThrows(() => requireLinux("reading /proc", "windows"), Unsupported, "(windows)");
});

Deno.test("parentFromStat and startTimeOf: the name between parentheses may hold spaces and parentheses", () => {
  assertEquals(parentFromStat("123 (claude (x) y) S 77 1 2"), 77);
  assertEquals(parentFromStat("123 (deno) S 0 1 2"), null);
  const stat = `123 (a) b) S 1 123 123 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 1000 100 1844`;
  assertEquals(startTimeOf(stat), "987654");
  assertEquals(startTimeOf(""), null);
});

Deno.test("parseEtimes: pid and seconds, junk skipped", () => {
  const m = parseEtimes("  100   42\n  200 3600\nnoise\n");
  assertEquals([...m], [[100, 42], [200, 3600]]);
});
