// proc.ts — Running programs: run() captures a command's output, which() finds an executable on PATH
// without a shell.

export async function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const p = new Deno.Command(cmd, { args, cwd: opts.cwd, env: opts.env, stdout: "piped", stderr: "piped" });
    const r = await p.output();
    const dec = new TextDecoder();
    return { code: r.code, out: dec.decode(r.stdout).trim(), err: dec.decode(r.stderr).trim() };
  } catch {
    return { code: 127, out: "", err: `${cmd}: not found` };
  }
}
/**
 * The executable `cmd` resolves to: itself when it contains a slash, else the first match on
 * PATH. No shell is involved, so a name from a configuration file is never run.
 */
export async function which(cmd: string, path = Deno.env.get("PATH") ?? ""): Promise<string | null> {
  const candidates = cmd.includes("/") ? [cmd] : path.split(":").filter(Boolean).map((d) => `${d}/${cmd}`);
  for (const c of candidates) {
    try {
      const st = await Deno.stat(c);
      if (st.isFile && (st.mode ?? 0) & 0o111) return c;
    } catch {
      // not there: the next directory
    }
  }
  return null;
}
export async function has(cmd: string) {
  return (await which(cmd)) !== null;
}
