// mcp.ts — The MCP registry against the surfaces, its validity, and the health of each server.

import { legacyStatePresent, plan } from "../../mcp/apply.ts";
import { health } from "../../mcp/health.ts";
import { loadRegistry, registryProblems } from "../../mcp/registry.ts";
import { REPO } from "../../lib/paths.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** The MCP registry against the surfaces, its validity, and the health of each server. */
export async function mcpChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- MCP: registry against the surfaces, plus dependencies
  try {
    const { changes } = await plan();
    if (!changes.length) add("mcp.sync", "ok", "MCP registry applied on CLI and Desktop");
    else {add(
        "mcp.sync",
        "warn",
        `MCP registry out of sync: ${changes.length} changes (${
          [...new Set(changes.map((x) => x.target.managedKey))].join(", ")
        })`,
        "claude-multi mcp sync (with Claude closed)",
      );}
    const problems = registryProblems(await loadRegistry());
    if (problems.length) {
      add(
        "mcp.registry",
        "fail",
        `MCP registry: ${problems.join("; ")}`,
        "correct shared/mcp/servers.json (README › MCP)",
      );
    }
  } catch (e) {
    add("mcp.sync", "fail", `MCP registry: ${(e as Error).message}`);
  }
  c.push(...await health());
  return c;
}

/** The old in-repo MCP sync state file. */
export async function mcpLegacyChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  if (await legacyStatePresent()) {
    add(
      "mcp.legacy",
      "warn",
      "shared/mcp/.sync-state.json is a leftover of the old sync script",
      `rm ${REPO}/shared/mcp/.sync-state.json`,
    );
  }
  return c;
}
