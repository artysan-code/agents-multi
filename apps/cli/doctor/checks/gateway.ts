// gateway.ts — The lazy MCP gateway (docs/adr/0008): alive, its configuration and tool-list cache in place,
// its tokens private, and a session unable to reach it by hand.

import { codeVersion } from "../../codeversion.ts";
import { gatewayHealth } from "../../console/gateway.ts";
import { readJson, stat } from "../../lib/fs.ts";
import { type Check } from "../../lib/output.ts";
import { REPO } from "../../lib/paths.ts";
import { cacheState, gatewayConfig } from "../../mcp/gateway.ts";
import { backendsPath, tokenFileOf } from "../../mcp/gateway-settings.ts";
import { loadRegistry } from "../../mcp/registry.ts";
import { checkList } from "../context.ts";

/** What a Claude session must not do by hand: the gateway answers any process that holds a profile's token,
 *  and a call made that way would skip the `ask` and `deny` rules the permission system applies to tools. */
export const GATEWAY_DENY = [
  "Bash(curl *127.0.0.1:7332*)",
  "Bash(curl *localhost:7332*)",
  "Bash(wget *127.0.0.1:7332*)",
  "Bash(wget *localhost:7332*)",
  "Read(~/.agents-multi/*/mcp-token)",
  "Edit(~/.agents-multi/*/mcp-token)",
  "Bash(*mcp-token*)",
];

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
    const h = await gatewayHealth(g.port);
    if (h) {
      add(
        "mcp.gateway",
        "ok",
        `MCP gateway running on 127.0.0.1:${g.port} (pid ${h.pid}, ${h.backends} backend(s) up)`,
      );
      if (h.code !== await codeVersion()) {
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
    const want = await gatewayConfig(reg, await codeVersion());
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
    for (const profile of Object.keys(want.profiles)) {
      const file = tokenFileOf(profile, g.runtime);
      const p = gatewayTokenProblem(file, (await stat(file))?.mode ?? null);
      if (p) add("mcp.gateway.token", p.status, p.msg, p.fix);
    }
    const deny = (await readJson<{ permissions?: { deny?: string[] } }>(`${REPO}/shared/settings.json`))?.permissions
      ?.deny ?? [];
    const absent = GATEWAY_DENY.filter((r) => !deny.includes(r));
    if (absent.length) {
      add(
        "mcp.gateway.deny",
        "fail",
        `Claude sessions could call the gateway by hand: shared deny lacks ${absent.join(", ")}`,
        "console › System › Permissions › Denied",
      );
    }
  } catch (e) {
    add("mcp.gateway", "fail", `MCP gateway: ${(e as Error).message}`);
  }
  return c;
}
