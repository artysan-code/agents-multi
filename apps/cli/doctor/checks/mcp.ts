// mcp.ts — The MCP registry against the surfaces, its validity, and the health of each server.

import { plan } from "../../mcp/apply.ts";
import { staleLaunchConfigs } from "../../mcp/config.ts";
import { health } from "../../mcp/health.ts";
import { loadRegistry, rawProblems, rawRegistry, registryProblems } from "../../mcp/registry.ts";
import { type Check } from "../../lib/output.ts";
import { checkList } from "../context.ts";

/** The MCP launch configs and Desktop's servers against the registry, its validity, and the health of each server. */
export async function mcpChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  // --- MCP: the CLI gets its servers at launch (mcp.json), Desktop's are written while it is closed
  try {
    // out of date is not wrong: bin/claude rebuilds the file before it starts Claude (prelaunch.sh)
    const stale = await staleLaunchConfigs();
    add(
      "mcp.launch",
      "ok",
      stale.length
        ? `MCP launch config rebuilt at the next launch of ${stale.join(", ")}`
        : "MCP launch config of every profile matches the registry",
    );
    // waiting for Desktop to be closed is not wrong either: claude-launch applies it when it opens the app
    const { changes } = await plan();
    add(
      "mcp.desktop",
      "ok",
      changes.length
        ? `${changes.length} MCP changes for Desktop, written when it is next opened`
        : "MCP servers of Claude Desktop match the registry",
    );
    const problems = [...rawProblems((await rawRegistry()).servers), ...registryProblems(await loadRegistry())];
    if (problems.length) {
      add(
        "mcp.registry",
        "fail",
        `MCP registry: ${problems.join("; ")}`,
        "correct shared/mcp/servers.json (README › MCP)",
      );
    }
  } catch (e) {
    add("mcp.registry", "fail", `MCP registry: ${(e as Error).message}`);
  }
  c.push(...await health());
  return c;
}
