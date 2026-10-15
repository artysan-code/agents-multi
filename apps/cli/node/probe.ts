// probe.ts — what a node checks about itself before it takes work (ADR 0012): that Claude Code's Bash sandbox
// can start here (bubblewrap able to make its namespaces and a fresh /proc, socat present), and that nothing of
// ours listens beyond loopback. A headless node whose probe fails takes no job and fires no routine.

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
