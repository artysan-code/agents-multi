// account.ts — `agents account`: the limits manager from a terminal (shared/mcp/lib/limitrules.ts, ADR 0010).
// Where the accounts stand against the owner's rules, a project's default account, and the proposals to use
// another one. Nothing switches an account without the owner: accepting a proposal is the owner's act.

import { scopeOf } from "../../shared/mcp/lib/agents.ts";
import {
  accountId,
  decide,
  limitsDir,
  listProposals,
  loadRules,
  parseAccountId,
  projectAccount,
  propose,
  readEvents,
  readSnapshot,
  setProjectAccount,
} from "../../shared/mcp/lib/limitrules.ts";
import { listAccounts } from "../../shared/mcp/lib/providers.ts";
import { applyProposals, readRoutine } from "../../shared/mcp/lib/routines.ts";
import { CONFIG } from "./lib/paths.ts";
import { inHours } from "./limits.ts";

const USAGE =
  `agents account status                          each account against the rules (stop at 80%…), this project's default
agents account default [<profile>[/<provider>]]  this project's default account: show it, or set it (config/projects.json)
agents account proposals                       the proposals to use another account (a held routine raises one)
agents account propose project|<routine-id> <profile>[/<provider>] [why…]
agents account accept|decline <id>             the owner's answer; accepted ones are applied at once
agents account events [--follow]               what the manager raised: blocked, expiring (a window about to reset with room), reset

Rules are the owner's \`limits.json\` in their configuration: {"stopAt": 80, "expiringMin": 60, "roomPercent": 30, "holdMaxMin": 720}.`;

export async function accountCommand(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  try {
    switch (sub) {
      case "status": {
        const snap = await readSnapshot();
        const now = Date.now() / 1000;
        const rules = await loadRules(CONFIG);
        const me = await scopeOf();
        console.log(
          snap
            ? `scanned ${new Date(snap.at * 1000).toISOString()} — stop at ${rules.stopAt}%`
            : "no scan yet (the console scans every minute)",
        );
        for (const a of await listAccounts(CONFIG)) {
          const s = snap?.accounts[a.id];
          const w = (s?.windows ?? []).map((x) =>
            `${x.window} ${Math.round(x.usedPercent)}% (resets ${inHours(x.resetsAt, now)})`
          )
            .join(", ");
          console.log(`${a.id.padEnd(22)} ${(s?.status ?? "unknown").padEnd(8)} ${w || "no reading"}`);
        }
        const d = await projectAccount(me.project, CONFIG);
        console.log(`default for ${me.project}: ${d ? accountId(d) : "none"}`);
        return 0;
      }
      case "default": {
        const me = await scopeOf();
        if (!rest[0]) {
          const d = await projectAccount(me.project, CONFIG);
          console.log(d ? accountId(d) : "none");
          return 0;
        }
        const a = parseAccountId(rest[0]);
        if (!a || !(await listAccounts(CONFIG)).some((x) => x.id === accountId(a))) {
          throw new Error(`no account ${rest[0]}`);
        }
        await setProjectAccount(me.project, a, CONFIG);
        console.log(`${me.project}: ${accountId(a)}`);
        return 0;
      }
      case "proposals": {
        const all = await listProposals();
        if (!all.length) console.log("no proposals");
        for (const p of all) {
          console.log(
            `${p.id}  ${p.status}  ${
              p.scope === "routine" ? p.routine : p.project
            }: ${p.from} → ${p.to}  (${p.reason})`,
          );
        }
        return 0;
      }
      case "propose": {
        const [target, to, ...why] = rest;
        if (!target || !to) break;
        const me = await scopeOf();
        const accounts = (await listAccounts(CONFIG)).map((a) => a.id);
        const a = parseAccountId(to);
        if (!a) throw new Error(`not an account: ${to}`);
        let from = "none";
        if (target === "project") {
          const d = await projectAccount(me.project, CONFIG);
          if (d) from = accountId(d);
        } else {
          const r = await readRoutine(target);
          if (!r || r.action.kind !== "agent") throw new Error(`no routine ${target} that runs a child`);
          from = accountId({ profile: r.action.profile, provider: r.action.provider ?? "claude" });
        }
        const p = await propose({
          scope: target === "project" ? "project" : "routine",
          project: me.project,
          routine: target === "project" ? undefined : target,
          from,
          to: accountId(a),
          reason: why.join(" ") || "proposed from the terminal",
          by: "coordinator",
        }, accounts);
        console.log(`${p.id}  ${p.from} → ${p.to}  pending`);
        return 0;
      }
      case "accept":
      case "decline": {
        if (!rest[0]) break;
        const p = await decide(rest[0], sub === "accept");
        if (sub === "accept") await applyProposals((t, b) => console.log(`${t}: ${b}`), undefined, limitsDir(), CONFIG);
        console.log(`${p.id}: ${p.status}`);
        return 0;
      }
      case "events": {
        const show = (e: { at: string; kind: string; detail: string }) =>
          console.log(`${e.at}  ${e.kind}  ${e.detail}`);
        const seen = new Set<string>();
        for (const e of await readEvents(undefined, 20)) (seen.add(e.id), show(e));
        if (rest.includes("--follow")) {
          for (;;) {
            await new Promise((r) => setTimeout(r, 5000));
            for (const e of await readEvents(undefined, 50)) if (!seen.has(e.id)) (seen.add(e.id), show(e));
          }
        }
        return 0;
      }
    }
  } catch (e) {
    console.error(`agents account ${sub}: ${(e as Error).message}`);
    return 1;
  }
  console.error(USAGE);
  return 2;
}
