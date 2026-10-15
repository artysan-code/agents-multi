// probe.ts — what a node checks about itself before it takes work (ADR 0012): that Claude Code's Bash sandbox
// can start here (bubblewrap able to make its namespaces and a fresh /proc, socat present), that what a child runs
// does not see its account's token (ADR 0013), and that nothing of ours listens beyond loopback. A headless node
// whose probe fails takes no job and fires no routine.

import { platformOf } from "../../../shared/mcp/lib/platform.ts";

export interface Probe {
  ok: boolean;
  reason?: string;
}

/** The command that tries what the sandbox needs: every namespace bubblewrap makes, and a fresh /proc (what
 *  Docker's defaults refuse; the node image's seccomp profile and `systempaths=unconfined` allow). */
export const PROBE_ARGS = [
  "--ro-bind",
  "/",
  "/",
  "--dev",
  "/dev",
  "--proc",
  "/proc",
  "--unshare-all",
  "--die-with-parent",
  "true",
];

/** Pure: the probe's verdict from bubblewrap's exit and what it said, and whether socat (the sandbox's network
 *  relay) is there. */
export function probeVerdict(r: { code: number; err: string } | null, socat: boolean): Probe {
  if (!r) return { ok: false, reason: "bubblewrap (bwrap) is not installed" };
  if (r.code !== 0) {
    const said = r.err.trim().split("\n").pop()?.replace(/^bwrap: /, "") || `exit ${r.code}`;
    const hint = /namespace|Operation not permitted|proc/i.test(said)
      ? " (in a container: the node's seccomp profile, systempaths=unconfined and, with AppArmor, its profile)"
      : "";
    return { ok: false, reason: `bubblewrap cannot make the sandbox: ${said}${hint}` };
  }
  if (!socat) return { ok: false, reason: "socat is not installed (the sandbox's network relay)" };
  return { ok: true };
}

async function runs(cmd: string, args: string[]): Promise<{ code: number; err: string } | null> {
  try {
    const r = await new Deno.Command(cmd, { args, stdin: "null", stdout: "null", stderr: "piped" }).output();
    return { code: r.code, err: new TextDecoder().decode(r.stderr) };
  } catch {
    return null; // not installed
  }
}

/** Whether the Bash sandbox can run on this machine. macOS has it built in; Windows has none. */
export async function sandboxProbe(): Promise<Probe> {
  const p = platformOf();
  if (p === "darwin") return { ok: true };
  if (p === "windows") return { ok: false, reason: "Claude Code has no Bash sandbox on Windows" };
  const socat = (await runs("socat", ["-V"]))?.code === 0;
  return probeVerdict(await runs("bwrap", PROBE_ARGS), socat);
}

/** Pure: the token probe's verdict from what its hook wrote — how many of the token, a plain variable and a
 *  credential canary it saw — or null when the hook never ran. */
export function tokenVerdict(seen: string | null): Probe {
  if (seen === null) {
    return { ok: false, reason: "Claude Code did not run the probe's hook: the token's scrub is unchecked" };
  }
  const [token, plain, canary] = seen.trim().split(/\s+/).map(Number);
  if (plain !== 1) return { ok: false, reason: "the probe's hook saw none of its environment: unchecked" };
  if (token !== 0) {
    return { ok: false, reason: "what a child runs would see its account's token (CLAUDE_CODE_OAUTH_TOKEN)" };
  }
  if (canary !== 0) {
    return { ok: false, reason: "Claude Code's subprocess scrub is off here: credentials reach what a child runs" };
  }
  return { ok: true };
}

/** Whether what a child runs is kept from its account's token: Claude Code started as a headless child is, with a
 *  throwaway token, the scrub on and a credential canary, and a SessionStart hook that counts what it sees. The
 *  hook runs before any request, so the probe spends nothing (the request is refused: the token is not real). */
export async function tokenProbe(claude = `${Deno.env.get("HOME")}/.local/bin/claude-bin`): Promise<Probe> {
  const dir = await Deno.makeTempDir({ prefix: "agents-token-probe-" });
  try {
    const out = `${dir}/seen`;
    const hook = `{ env | grep -c '^CLAUDE_CODE_OAUTH_TOKEN='; env | grep -c '^AM_PROBE_PLAIN='; ` +
      `env | grep -c '^NPM_TOKEN='; } > '${out}'; true`;
    await Deno.writeTextFile(
      `${dir}/settings.json`,
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: hook }] }] } }),
    );
    await Deno.mkdir(`${dir}/cfg`);
    const r = await new Deno.Command("timeout", {
      args: ["60", claude, "-p", "probe", "--settings", `${dir}/settings.json`],
      // in its own folder: Claude Code leaves files where it starts (empty .env*, package.json)
      cwd: dir,
      clearEnv: true,
      env: {
        HOME: dir,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        CLAUDE_CONFIG_DIR: `${dir}/cfg`,
        // the shape of a real token, never one (made of parts, so that no secret scanner takes it for one)
        CLAUDE_CODE_OAUTH_TOKEN: `${["sk", "ant", "oat01"].join("-")}-agents-multi-probe-${crypto.randomUUID()}`,
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
        DISABLE_AUTOUPDATER: "1",
        AM_PROBE_PLAIN: "1",
        NPM_TOKEN: "agents-multi-probe",
      },
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output().catch(() => null);
    if (!r) return { ok: false, reason: `Claude Code is not at ${claude}` };
    return tokenVerdict(await Deno.readTextFile(out).catch(() => null));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** A headless node's checks before it takes work: the sandbox, then the token's scrub. */
export async function headlessProbe(): Promise<Probe> {
  const s = await sandboxProbe();
  return s.ok ? await tokenProbe() : s;
}

/** Pure: of `ss -Hltn`'s listeners, the ones on these ports bound beyond loopback (`0.0.0.0`, `*`, `[::]` or
 *  a real address). */
export function exposedListeners(ss: string, ports: number[]): string[] {
  const out: string[] = [];
  for (const line of ss.split("\n")) {
    const local = line.trim().split(/\s+/)[3];
    const m = local?.match(/^(.*):(\d+)$/);
    if (!m || !ports.includes(Number(m[2]))) continue;
    const host = m[1].replace(/^\[|\]$/g, "").replace(/%.*$/, "");
    if (!["127.0.0.1", "::1", "localhost"].includes(host) && !host.startsWith("127.")) out.push(local);
  }
  return out;
}
