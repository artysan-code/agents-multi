// runs.ts — what this node publishes of its runs to the phone's Agents view (ADR 0014, third round, B): the
// machine's choice (`runs` in its node.json), and whether the owner's repositories can be told from a client's.

import { loadNodeConfig, type NodeConfig } from "../../../../shared/mcp/lib/headless.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** Pure: what the doctor says of the runs this node publishes. */
export function runsFindings(cfg: NodeConfig & { gitHosts?: string[] }): Check[] {
  const [c, add] = checkList();
  if (!cfg.enabled) return c;
  const mode = cfg.runs ?? "full";
  if (mode === "off") {
    add("node.runs", "ok", "its runs are not published (runs: off in this machine's node.json)");
  } else if (!cfg.repos.length && !cfg.gitHosts?.length) {
    // a repository that is not in repos nor gitHosts is a client's: its runs go as their state only, names hidden
    add(
      "node.runs",
      "warn",
      "every run is published as a client's (state only, names hidden): no repos and no gitHosts say what is yours",
      'list your forge in gitHosts of config/nodes.json ("git.example.me" or "github.com/you")',
    );
  } else {
    add(
      "node.runs",
      "ok",
      `publishes its runs to the Agents view: ${mode === "full" ? "state and output" : "state only"}`,
    );
  }
  return c;
}

export async function runsChecks(): Promise<Check[]> {
  return runsFindings(await loadNodeConfig());
}
