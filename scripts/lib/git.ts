// git.ts — the release scripts' git runner, one copy.

const decode = (b: Uint8Array) => new TextDecoder().decode(b).trim();

/** Runs git in the current folder and returns its trimmed output; throws with git's message on failure. */
export async function git(...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")}: ${decode(out.stderr)}`);
  return decode(out.stdout);
}

/** Runs git in `cwd`, its output going to ours; throws when it fails. */
export async function gitIn(cwd: string, ...args: string[]): Promise<void> {
  const out = await new Deno.Command("git", { args, cwd, stdout: "inherit", stderr: "inherit" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")} failed`);
}
