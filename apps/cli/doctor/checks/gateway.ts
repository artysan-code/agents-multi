// gateway.ts — The lazy MCP gateway (docs/adr/0008): alive, its configuration and tool-list cache in place,
// its tokens private, and a session unable to reach it by hand.

import { gatewayCodeVersion } from "../../codeversion.ts";
import { gatewayRunning } from "../../console/gateway.ts";
import { readJson, stat } from "../../lib/fs.ts";
import { type Check } from "../../lib/output.ts";
import { HOME } from "../../lib/paths.ts";
import { cacheState, gatewayConfig, serverVersion } from "../../mcp/gateway.ts";
import { backendsPath, gatewayDenyRules, runtimeNames, tokenFileOf } from "../../mcp/gateway-settings.ts";
import { loadRegistry } from "../../mcp/registry.ts";
import { checkList } from "../context.ts";

/** Pure: what is wrong with a profile's token file (mode null: it is not there), or null. */
export function gatewayTokenProblem(
  file: string,
  mode: number | null,
): { status: "warn" | "fail"; msg: string; fix: string } | null {
  if (mode == null) {
    return {
      status: "warn",
      msg: `the gateway token ${file} is missing: made at the next launch of that profile`,
      fix: "agents settings",
    };
  }
  if ((mode & 0o077) !== 0) {
    return {
      status: "fail",
      msg: `the gateway token ${file} can be read by others (mode ${(mode & 0o777).toString(8)})`,
      fix: `chmod 600 ${file}`,
    };
  }
  return null;
}

/** The gateway: whether it is wanted, alive, configured, cached and closed to the profiles' sessions' own hands. */
export async function gatewayChecks(): Promise<Check[]> {
  const [c, add] = checkList();
  try {
    const reg = await loadRegistry();
    const g = reg.gateway!;
    if (!g.enabled) {
      add("mcp.gateway", "ok", "MCP gateway off: each session starts its own servers (config gateway.json)");
      return c;
    }
    const run = await gatewayRunning(g);
    if (run) {
      add("mcp.gateway", "ok", `MCP gateway running on 127.0.0.1:${g.port}${run.pid ? ` (pid ${run.pid})` : ""}`);
      if (run.pid && run.code !== await gatewayCodeVersion()) {
        add("mcp.gateway.code", "warn", "the MCP gateway runs older code than the one on disk", "restart Agents Multi");
      }
    } else {
      add(
        "mcp.gateway",
        "warn",
        `MCP gateway is not answering on 127.0.0.1:${g.port}: sessions cannot reach their MCP servers`,
        "the console starts it within seconds; without one, run: agents gateway run",
      );
    }
    const want = await gatewayConfig(reg, serverVersion);
    const have = await readJson<unknown>(backendsPath(g.runtime));
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      add("mcp.gateway.config", "ok", "the gateway's backends.json is rebuilt at the next launch of a profile");
    }
    const missing = (await cacheState(want, g.runtime)).filter((s) => !s.cached);
    if (missing.length) {
      add(
        "mcp.gateway.cache",
        "warn",
        `no cached tool list for ${
          missing.map((m) => `${m.profile}/${m.name}`).join(", ")
        }: the first session to open one starts it`,
        "agents mcp warm",
      );
    }
    // the effective files of each profile, not the repository's base: what Claude really loads
    const rules = gatewayDenyRules(g.port, runtimeNames(g.runtime, HOME));
    for (const profile of Object.keys(want.profiles)) {
      const file = tokenFileOf(profile, g.runtime);
      const p = gatewayTokenProblem(file, (await stat(file))?.mode ?? null);
      if (p) add("mcp.gateway.token", p.status, p.msg, p.fix);
      const deny = (await readJson<{ permissions?: { deny?: string[] } }>(`${g.runtime}/${profile}/settings.json`))
        ?.permissions?.deny ?? [];
      const absent = rules.filter((r) => !deny.includes(r));
      if (absent.length) {
        add(
          "mcp.gateway.deny",
          "fail",
          `${profile}: Claude sessions could call the gateway by hand: its settings.json lacks ${absent.join(", ")}`,
          "agents settings",
        );
      }
      const urls = Object.values(
        (await readJson<{ mcpServers?: Record<string, { url?: string }> }>(`${g.runtime}/${profile}/mcp.json`))
          ?.mcpServers ?? {},
      ).map((c) => c.url ?? "").filter((u) => u.includes("/p/"));
      const wrong = urls.filter((u) => !u.startsWith(`http://127.0.0.1:${g.port}/p/${profile}/`));
      if (wrong.length) {
        add(
          "mcp.gateway.port",
          "fail",
          `${profile}: mcp.json points at ${wrong[0]}, not at the gateway on port ${g.port}`,
          "agents mcp sync",
        );
      }
    }
  } catch (e) {
    add("mcp.gateway", "fail", `MCP gateway: ${(e as Error).message}`);
  }
  return c;
}
