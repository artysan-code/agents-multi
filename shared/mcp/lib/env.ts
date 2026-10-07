// env.ts — the project's environment variables. AGENTS_MULTI_<NAME> is the name; CLAUDE_MULTI_<NAME>
// (the project's name before Agents Multi) is still read when the new one is not set, so a
// configuration written before the rename keeps working. The old names go at 1.0.
//
// A server started with a narrow --allow-env (placement.ts) is not allowed to read a name it was not
// given: a read of the other name then throws, and is the same as "not set".

/** The value of AGENTS_MULTI_<name>, else of CLAUDE_MULTI_<name>, else undefined. */
export function amEnv(name: string): string | undefined {
  for (const prefix of ["AGENTS_MULTI_", "CLAUDE_MULTI_"]) {
    try {
      const v = Deno.env.get(prefix + name);
      if (v !== undefined) return v;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotCapable)) throw e;
    }
  }
  return undefined;
}

/** `{ AGENTS_MULTI_<name>: value, CLAUDE_MULTI_<name>: value }`: what to hand to a process that may be the
 *  old code (after a rollback) or the new. */
export function amEnvBoth(name: string, value: string): Record<string, string> {
  return { [`AGENTS_MULTI_${name}`]: value, [`CLAUDE_MULTI_${name}`]: value };
}
