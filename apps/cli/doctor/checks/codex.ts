// codex.ts — Codex (OpenAI) as a provider: only where a profile declares a Codex account. Its CLI is
// installed at the version the repository pins, and each account has a login (its presence only: the
// file is never read).

import { codexBin, codexHome } from "../../../../shared/mcp/lib/codex.ts";
import { stat } from "../../lib/fs.ts";
import { REPO, RUNTIME } from "../../lib/paths.ts";
import { type Check } from "../../lib/output.ts";
import { loadManifest, profileNames } from "../../lib/profiles.ts";
import { checkList } from "../context.ts";

/** The Codex accounts: the CLI at its pin, a login for each profile that declares one. */
export async function codexChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  const declared: string[] = [];
  for (const p of await profileNames()) if ((await loadManifest(p)).codex) declared.push(p);
  if (!declared.length) return c;

  const pin = (await Deno.readTextFile(`${REPO}/shared/providers/codex.version`).catch(() => "")).trim();
  const have = await Deno.readTextFile(`${RUNTIME}/providers/codex/node_modules/@openai/codex/package.json`)
    .then((t) => JSON.parse(t).version as string).catch(() => "");
  if (!(await stat(codexBin(RUNTIME))) || !have) {
    add(
      "codex.cli",
      "fail",
      `Codex is not installed (${declared.join(", ")} declare an account)`,
      "agents update --codex",
    );
  } else if (pin && have !== pin) {
    add("codex.cli", "warn", `Codex ${have} is installed, the pinned version is ${pin}`, "agents update --codex");
  } else add("codex.cli", "ok", `Codex ${have}`);
  for (const p of declared) {
    if (!(await stat(`${codexHome(RUNTIME, p)}/auth.json`))) {
      add(`codex.login.${p}`, "warn", `${p}: no Codex login`, `agents codex ${p} login`);
    }
  }
  return c;
}
