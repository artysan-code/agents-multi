// lib.ts — what Add a server decides without the network: whether a typed code can be one (the service reads it
// the same tolerant way: case, dashes, spaces, Crockford's look-alikes) and where a paired server stands. Pure, so
// it has a test (apps/cli/tests/servers_test.ts).

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Pure: the code as the service will read it (XXXX-XXXX), or null when it cannot be one. */
export function typedCode(s: string): string | null {
  const c = s.toUpperCase().replace(/[\s-]+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return c.length === 8 && [...c].every((x) => ALPHABET.includes(x)) ? `${c.slice(0, 4)}-${c.slice(4)}` : null;
}

export type Stage = "unseen" | "offline" | "waiting" | "ready";

/** Pure: where a paired server stands: not announced yet (it has no configuration, or setup has not run), offline,
 *  online with something still waiting (a token, the forge), or ready to take work. */
export function stageOf(s: { known: boolean; online?: boolean; waits?: string[]; sandbox?: boolean | null }): Stage {
  if (!s.known) return "unseen";
  if (!s.online) return "offline";
  return (s.waits?.length ?? 0) > 0 || s.sandbox !== true ? "waiting" : "ready";
}
