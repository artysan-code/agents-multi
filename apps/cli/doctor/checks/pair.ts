// pair.ts — a server paired from the console (ADR 0013, F2): the key pair it paired with is the user's alone while it
// waits, and gone once it has served (the token is there): it opened the vault key once and is worth nothing after,
// but a copy left behind is one more thing to steal.

import { type Check } from "../../lib/output.ts";
import { pairKeyFile } from "../../node/pair.ts";
import { nodeTokenFile } from "../../node/service.ts";
import { checkList } from "../context.ts";

export interface PairFacts {
  /** the pairing key file's mode (`& 0o777`), null when there is none */
  keyMode: number | null;
  /** this machine has its node token */
  paired: boolean;
}

/** Pure: what the doctor says of a server's pairing key. Nothing when there is none: a desktop, or a server done. */
export function pairFindings(f: PairFacts): Check[] {
  const [c, add] = checkList();
  if (f.keyMode === null) return c;
  if (f.keyMode & 0o077) {
    add(
      "node.pair",
      "fail",
      `the server's pairing key is readable by others (mode ${f.keyMode.toString(8)})`,
      `chmod 600 ${pairKeyFile()}`,
    );
  } else if (f.paired) {
    add(
      "node.pair",
      "warn",
      "paired, but the pairing key is still here: it has served",
      `rm ${pairKeyFile()}`,
    );
  } else add("node.pair", "ok", "a server waiting to be paired from the console: its key is the user's alone (0600)");
  return c;
}

export async function pairChecks(): Promise<Check[]> {
  const mode = (p: string) => Deno.stat(p).then((s) => s.mode != null ? s.mode & 0o777 : 0o600, () => null);
  return pairFindings({ keyMode: await mode(pairKeyFile()), paired: (await mode(nodeTokenFile())) !== null });
}
