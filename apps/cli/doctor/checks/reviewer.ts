// reviewer.ts — The owner's rules for the reviewer of unattended runs (config/reviewer.json, ADR 0011).

import { broadAllows, cleanRules } from "../../../../shared/mcp/lib/reviewer.ts";
import { CONFIG } from "../../lib/paths.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** Pure: what the doctor says of the reviewer's rules: none (every request of a routine waits for the owner,
 *  then is refused), a file that is not JSON, entries it drops, and `allow`s that let a run do anything. */
export function reviewerFindings(text: string | null): Check[] {
  const [c, add] = checkList();
  const fix =
    "edit ~/.agents-multi/config/reviewer.json (docs/adr/0011-reviewer.md); agents review rules shows the result";
  if (text === null) {
    add(
      "reviewer.rules",
      "ok",
      "no reviewer rules: what a routine's child asks for waits for you, then is refused (config/reviewer.json)",
    );
    return c;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    add(
      "reviewer.rules",
      "warn",
      "reviewer.json is not JSON: the reviewer reads no rules, every request is an ask",
      fix,
    );
    return c;
  }
  const { rules, rejected } = cleanRules(raw);
  if (rejected.length) {
    add(
      "reviewer.rules",
      "warn",
      `reviewer.json: ${rejected.length} entries ignored: ${rejected.slice(0, 3).join("; ")}`,
      fix,
    );
  } else {
    const n = rules.allow.length + rules.ask.length + rules.deny.length + rules.review.length;
    add(
      "reviewer.rules",
      "ok",
      `reviewer: ${n} rules, an ask waits ${rules.askMin} minutes, judge ${rules.judge.model}`,
    );
  }
  const broad = broadAllows(rules);
  if (broad.length) {
    add(
      "reviewer.broad",
      "warn",
      `reviewer.json allows ${broad.join(", ")}: an unattended run could do anything with it`,
      "allow the exact commands or tools instead (Bash(wrangler deploy --env dev:*))",
    );
  }
  return c;
}

/** The owner's rules for the reviewer. */
export async function reviewerChecks(): Promise<Check[]> {
  return reviewerFindings(await Deno.readTextFile(`${CONFIG}/reviewer.json`).catch(() => null));
}
