// agent.ts — `agents agent`: the hub's children from a terminal (shared/mcp/lib/agents.ts). The same
// operations the coordinator's MCP server gives a Claude: start one in a project's folder with a
// profile, see them, talk to one, answer its permission requests and questions, stop it, follow what
// needs you.

import {
  answer,
  attentionOf,
  type Child,
  followAttention,
  listChildren,
  readChild,
  sayTo,
  startChild,
  stopChild,
  type Verdict,
  waitForAttention,
} from "../../shared/mcp/lib/agents.ts";

const USAGE = `agents agent start <profile> <folder> <task…> [--model m]   a child in that folder, with that profile
agents agent list                                   every child: phase, what it waits for
agents agent status <id>                            what it said last, its requests
agents agent say <id> <text…>                       a message, taken between two of its steps
agents agent answer <id> <request> allow|session|deny [why…] [--answers json]
                                                    one of its requests (session: and the like, until it ends),
                                                    or a question (--answers: {"question": "label"})
agents agent stop <id> [--force]                    ends after its turn (--force: now)
agents agent wait [--timeout s]                     returns when something needs you
agents agent events [--follow]                      what needs you, one JSON line each: what waits now
                                                    (--follow: then everything new, until stopped)`;

function line(c: Child): string {
  const s = c.state;
  const wait = s.pending.length
    ? ` · waits: ${s.pending.map((p) => `${p.what} [${p.request}; session: ${p.session}]`).join("; ")}`
    : "";
  return `${c.meta.id}  ${s.phase}  ${c.meta.profile}/${c.meta.mode ?? "default"}  ${c.meta.dir}${wait}`;
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
  try {
    switch (sub) {
      case "start": {
        const model = opt("--model");
        const [profile, dir, ...task] = rest;
        if (!profile || !dir || !task.length) break;
        const m = await startChild({ profile, dir, task: task.join(" "), model });
        console.log(`started ${m.id}: ${m.command} in ${m.dir}`);
        return 0;
      }
      case "list": {
        const all = await listChildren();
        console.log(all.length ? all.map(line).join("\n") : "no children");
        return 0;
      }
      case "status": {
        const c = rest[0] ? await readChild(rest[0]) : null;
        if (!c) break;
        console.log(JSON.stringify(c, null, 2));
        return 0;
      }
      case "say": {
        const [id, ...text] = rest;
        if (!id || !text.length) break;
        await sayTo(id, text.join(" "));
        console.log(`sent to ${id}`);
        return 0;
      }
      case "answer": {
        const json = opt("--answers");
        const [id, request, verdict, ...why] = rest;
        if (!id || !request || !["allow", "session", "deny"].includes(verdict)) break;
        const answers = json === undefined ? undefined : JSON.parse(json) as Record<string, string>;
        await answer(id, request, verdict as Verdict, why.join(" ") || undefined, undefined, answers);
        console.log(`${verdict} → ${id}`);
        return 0;
      }
      case "stop": {
        const force = has("--force");
        if (!rest[0]) break;
        await stopChild(rest[0], force);
        console.log(`stopping ${rest[0]}`);
        return 0;
      }
      case "wait": {
        const s = Number(opt("--timeout") ?? "3600");
        const found = await waitForAttention((Number.isFinite(s) && s > 0 ? s : 3600) * 1000);
        console.log(JSON.stringify(found, null, 2));
        return 0;
      }
      case "events": {
        const follow = has("--follow");
        if (!follow) {
          for (const c of await listChildren()) {
            if (c.state.phase === "ended") continue;
            for (const p of c.state.pending) console.log(JSON.stringify(attentionOf(c.meta.id, p)));
          }
          return 0;
        }
        for await (const a of followAttention()) console.log(JSON.stringify(a));
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
