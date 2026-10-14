// agent.ts — `agents agent`: the hub's children from a terminal (shared/mcp/lib/agents.ts). The same
// operations the coordinator's MCP server gives a Claude: start one in a project's folder with a
// profile, see them, talk to one, answer its permission requests and questions, stop it, follow what
// needs you.

import {
  adoptChild,
  answer,
  attentionOf,
  type Child,
  childIn,
  listChildren,
  ownerOf,
  sayTo,
  scopeOf,
  startChild,
  stopChild,
  type Verdict,
  waitForAttention,
} from "../../shared/mcp/lib/agents.ts";
import { follow } from "../../shared/mcp/lib/runs.ts";

const USAGE =
  `agents agent start <profile> <folder> <task…> [--model m] [--provider codex]   a child in that folder, with that profile
agents agent list [--project] [--all]               your session's children (and the project's orphans): phase, what it waits for
agents agent status <id> [--project] [--all]        what it said last, its requests
agents agent adopt <id>                             takes an orphan of this project: its coordinator is gone
agents agent say <id> <text…>                       a message, taken between two of its steps
agents agent answer <id> <request> allow|session|deny [why…] [--answers json]
                                                    one of its requests (session: and the like, until it ends),
                                                    or a question (--answers: {"question": "label"})
agents agent stop <id> [--force]                    ends after its turn (--force: now)
agents agent wait [--timeout s] [--project] [--all] returns when something needs you
agents agent events [--follow] [--project] [--all]  what needs you, one JSON line each: what waits now
                                                    (--follow: then everything new, workflow runs included)

A child or run belongs to the Claude session that started it (the nearest \`claude\` process above the caller)
and to a project (the main repository of the folder; a worktree counts as its repository). You see your
session's, and the orphans of your project (their session is gone: adopt one to act on it); answer, say and
stop act only on yours. --project adds the project's other live sessions' (read-only), --all every project's.`;

const markOf = (c: { access?: string }) =>
  c.access === "orphan"
    ? " [orphan]"
    : c.access === "peer"
    ? " [other session]"
    : c.access === "other"
    ? " [other project]"
    : "";

function line(c: Child): string {
  const s = c.state;
  const wait = s.pending.length
    ? ` · waits: ${s.pending.map((p) => `${p.what} [${p.request}; session: ${p.session}]`).join("; ")}`
    : "";
  return `${c.meta.id}  ${s.phase}  ${c.meta.profile}/${c.meta.mode ?? "default"}  ${c.meta.dir}${markOf(c)}${wait}`;
}

export async function agentCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const opt = (name: string) => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    rest.splice(i, 2);
    return v;
  };
  const has = (name: string) => {
    const i = rest.indexOf(name);
    if (i >= 0) rest.splice(i, 1);
    return i >= 0;
  };
  const flags = () => {
    has("--mine"); // the default now, still accepted
    return { all: has("--all"), project: has("--project") };
  };
  try {
    switch (sub) {
      case "start": {
        const model = opt("--model");
        const provider = opt("--provider") ?? "claude";
        if (provider !== "claude" && provider !== "codex") throw new Error("--provider is claude or codex");
        const [profile, dir, ...task] = rest;
        if (!profile || !dir || !task.length) break;
        const owner = ownerOf(await scopeOf());
        const m = await startChild({ profile, dir, task: task.join(" "), model, provider, owner });
        console.log(`started ${m.id}: ${m.command} in ${m.dir}`);
        return 0;
      }
      case "list": {
        const all = await listChildren(undefined, await scopeOf(flags()));
        console.log(all.length ? all.map(line).join("\n") : "no children");
        return 0;
      }
      case "status": {
        if (!rest[0]) break;
        console.log(JSON.stringify(await childIn(rest[0], await scopeOf(flags())), null, 2));
        return 0;
      }
      case "adopt": {
        if (!rest[0]) break;
        const me = await adoptChild(rest[0], await scopeOf());
        console.log(`adopted ${rest[0]} (session pid ${me.pid})`);
        return 0;
      }
      case "say": {
        const [id, ...text] = rest;
        if (!id || !text.length) break;
        await sayTo(id, text.join(" "), undefined, await scopeOf());
        console.log(`sent to ${id}`);
        return 0;
      }
      case "answer": {
        const json = opt("--answers");
        const [id, request, verdict, ...why] = rest;
        if (!id || !request || !["allow", "session", "deny"].includes(verdict)) break;
        const answers = json === undefined ? undefined : JSON.parse(json) as Record<string, string>;
        await answer(id, request, verdict as Verdict, why.join(" ") || undefined, undefined, answers, await scopeOf());
        console.log(`${verdict} → ${id}`);
        return 0;
      }
      case "stop": {
        const force = has("--force");
        if (!rest[0]) break;
        await stopChild(rest[0], force, undefined, await scopeOf());
        console.log(`stopping ${rest[0]}`);
        return 0;
      }
      case "wait": {
        const s = Number(opt("--timeout") ?? "3600");
        const found = await waitForAttention(
          (Number.isFinite(s) && s > 0 ? s : 3600) * 1000,
          undefined,
          undefined,
          await scopeOf(flags()),
        );
        console.log(JSON.stringify(found, null, 2));
        return 0;
      }
      case "events": {
        const live = has("--follow");
        const scope = await scopeOf(flags());
        if (!live) {
          for (const c of await listChildren(undefined, scope)) {
            if (c.state.phase === "ended") continue;
            for (const p of c.state.pending) console.log(JSON.stringify(attentionOf(c.meta.id, p)));
          }
          return 0;
        }
        for await (const a of follow(undefined, undefined, undefined, scope)) console.log(JSON.stringify(a));
        return 0;
      }
    }
  } catch (e) {
    console.error(`agents agent ${sub}: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}
