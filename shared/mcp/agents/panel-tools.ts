// panel-tools.ts — the agents panel (ADR 0014, C): an MCP App. `agents_panel` points the host at the
// `ui://agents/panel` page (panel/panel.html, one self-contained file), which the host shows in a frame
// and which asks again through the host with `agents_panel_state`. Its buttons call the tools that already
// exist (agent_answer, agent_stop, workflow_answer, workflow_status): no new authority. A host without MCP
// Apps ignores `_meta.ui` and the model reads the text summary.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { listChildren, scopeOf } from "../lib/agents.ts";
import { PANEL_MIME, PANEL_URI, type Snapshot, snapshotOf, summaryOf } from "../lib/panel.ts";
import { allLimits, placesFromEnv } from "../lib/providers.ts";
import { listRuns } from "../lib/runs.ts";

const html = await Deno.readTextFile(new URL("./panel/panel.html", import.meta.url));

/** No external origin: everything the page needs comes through the host. */
const resourceMeta = { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: true } };

/** The session's own children and runs (and its project's orphans), as agent_list reads them. */
async function snapshot(): Promise<Snapshot> {
  const scope = await scopeOf();
  const stale: string[] = [];
  const [children, runs, limits] = await Promise.all([
    listChildren(undefined, scope),
    listRuns(undefined, scope),
    allLimits(placesFromEnv()).catch(() => {
      stale.push("limits");
      return [];
    }),
  ]);
  return snapshotOf({ children, runs, limits, stale });
}

const result = (s: Snapshot, text: string) => ({
  content: [{ type: "text" as const, text }],
  structuredContent: s as unknown as Record<string, unknown>,
});
const fail = (e: unknown) => ({
  content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }],
  isError: true,
});

export function registerPanel(server: McpServer) {
  server.registerResource("agents-panel", PANEL_URI, {
    title: "Agents panel",
    description: "This session's children and workflow runs, what they ask, and the accounts' limits.",
    mimeType: PANEL_MIME,
    _meta: resourceMeta,
  }, () => ({ contents: [{ uri: PANEL_URI, mimeType: PANEL_MIME, text: html, _meta: resourceMeta }] }));

  server.registerTool("agents_panel", {
    description: "Open the panel of this session's children and runs: what they do, what they ask (with Yes / " +
      "No buttons for the owner), the runs' steps and the accounts' limits. Call it when the owner asks to see or " +
      "manage the agents. Where the host cannot show it, the result is a short summary.",
    inputSchema: {},
    _meta: { ui: { resourceUri: PANEL_URI }, "ui/resourceUri": PANEL_URI },
  }, async () => {
    try {
      const s = await snapshot();
      return result(s, summaryOf(s));
    } catch (e) {
      return fail(e);
    }
  });

  server.registerTool("agents_panel_state", {
    description: "The agents panel's data, for the panel itself: the model uses agent_list and workflow_list.",
    inputSchema: {},
    _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } },
  }, async () => {
    try {
      const s = await snapshot();
      return result(s, JSON.stringify(s));
    } catch (e) {
      return fail(e);
    }
  });
}
