// env.ts — the project's environment variables: AGENTS_MULTI_<NAME>.
//
// A server started with a narrow --allow-env (placement.ts) is not allowed to read a name it was not
// given: a read of another name then throws, and is the same as "not set".

/** The value of AGENTS_MULTI_<name>, else undefined. */
export function amEnv(name: string): string | undefined {
  try {
    return Deno.env.get("AGENTS_MULTI_" + name);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotCapable)) throw e;
    return undefined;
  }
}
