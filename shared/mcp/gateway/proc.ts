// proc.ts — a file of /proc/<pid>/ as text. Deno without --allow-all refuses to read another process's
// files directly, so this asks `cat` (the same as apps/cli/lib/processes.ts does); a process that is gone
// gives "".

export async function readProc(pid: number, file: "stat" | "cmdline"): Promise<string> {
  try {
    const r = await new Deno.Command("cat", {
      args: [`/proc/${pid}/${file}`],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    return r.success ? new TextDecoder().decode(r.stdout) : "";
  } catch {
    return "";
  }
}
