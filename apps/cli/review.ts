// review.ts — `agents review`: what the reviewer of unattended runs decided (shared/mcp/lib/reviewer.ts,
// ADR 0011), and the rules a project's runs get. Read-only: the rules are the owner's `reviewer.json` and a
// repository's `.agents/reviewer.json`; the console's backend is what decides.

import { projectOf } from "../../shared/mcp/lib/agents.ts";
import { broadAllows, cleanRules, type Decision, forcedRules, readDecisions } from "../../shared/mcp/lib/reviewer.ts";
import { CONFIG } from "./lib/paths.ts";

const USAGE = `agents review [-n 20] [--json]     the reviewer's last decisions on routines' requests (docs/adr/0011)
agents review rules [folder]       the rules a project's unattended runs get, and what is wrong with them`;

/** Pure: a decision in a line: when, verdict, who decided, the routine, what, and why. */
export const decisionLine = (d: Decision) =>
  `${d.at.slice(0, 16).replace("T", " ")}  ${d.verdict.padEnd(5)}  ${
    d.by.padEnd(7)
  }  ${d.routine}  ${d.what}  — ${d.reason}`;

const read = (f: string) => Deno.readTextFile(f).then(JSON.parse).catch(() => undefined);

export async function reviewCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "rules") {
    const project = await projectOf(rest[0] ?? Deno.cwd()).catch(() => null);
    if (!project) {
      console.error("not inside a git repository");
      return 1;
    }
    const { rules, rejected } = cleanRules(
      await read(`${CONFIG}/reviewer.json`),
      await read(`${project}/.agents/reviewer.json`),
    );
    const forced = forcedRules(rules);
    console.log(`project ${project}`);
    for (const k of ["deny", "ask", "allow"] as const) {
      console.log(`${k.padEnd(7)} ${rules[k].map((r) => r.text).join(", ") || "—"}`);
    }
    for (const r of rules.review) console.log(`review  ${r.text}: ${r.criterion}`);
    console.log(`ask     waits ${rules.askMin} minutes for the owner, then refused; anything no rule names is an ask`);
    console.log(
      `judge   ${rules.judge.model} on ${
        rules.judge.profile ?? "the child's account"
      }, at most ${rules.judge.maxPerDay} a day`,
    );
    console.log(`a routine's child always asks for: ${forced.ask.join(", ") || "—"}`);
    for (const r of rejected) console.log(`ignored: ${r}`);
    for (const r of broadAllows(rules)) console.log(`warning: allow ${r} lets an unattended run do anything`);
    return 0;
  }
  if (sub && !sub.startsWith("-")) {
    console.log(USAGE);
    return sub === "help" ? 0 : 1;
  }
  const json = args.includes("--json");
  const i = args.indexOf("-n");
  const n = i >= 0 ? Math.max(1, Number(args[i + 1]) || 20) : 20;
  const last = (await readDecisions()).slice(-n);
  if (json) console.log(JSON.stringify(last, null, 2));
  else if (!last.length) console.log("no decisions yet: the reviewer answers the requests of routines' children");
  else for (const d of last) console.log(decisionLine(d));
  return 0;
}
