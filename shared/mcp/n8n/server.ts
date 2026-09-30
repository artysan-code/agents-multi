#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run=/usr/bin/secret-tool
// n8n — MCP server on the n8n instances in accounts.json (service "n8n"; today: ark's).
//
// Ours instead of the n8n-mcp package: one process for every account, the account a call means
// named in the call, the API key read from the vault and never passed around. It covers working
// with workflows and their executions through n8n's public API. What that API does not offer, it
// does not fake: the catalogue of node types needs an editor session, not an API key, so there is
// no node documentation here — reading an existing workflow is the reference.
//
// **No deletion**, as in coolify: removing a workflow is done by hand, in n8n, looking at it.
// Values that look secret are masked on the way out (lib/mask.ts), and a write carrying the mask
// marker is refused, so a masked read edited and saved cannot overwrite a real secret.
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";
import { z } from "npm:zod@^3.23";
import { HIDDEN, maskDeep } from "../lib/mask.ts";
import { service, text } from "../lib/service.ts";

const n8n = service("n8n");
const account = n8n.accountArg;

// deno-lint-ignore no-explicit-any -- n8n's responses are consumed as documents, not typed
type Doc = any;

async function api(acc: string | undefined, path: string, init?: RequestInit): Promise<Doc> {
  const { account: a, secret } = await n8n.use(acc);
  const r = await fetch(`${a.url}/api/v1${path}`, {
    ...init,
    headers: { "X-N8N-API-KEY": secret, Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : null;
}

/** Every page of a listing (n8n pages with a cursor). */
async function all(acc: string | undefined, path: string, max = 500): Promise<Doc[]> {
  const out: Doc[] = [];
  let cursor = "";
  do {
    const sep = path.includes("?") ? "&" : "?";
    const r = await api(acc, `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...(r.data ?? []));
    cursor = r.nextCursor ?? "";
  } while (cursor && out.length < max);
  return out;
}

function refuseMasked(payload: unknown) {
  if (JSON.stringify(payload).includes(HIDDEN)) {
    throw new Error("the payload carries a masked value: saving it would replace the real secret. Leave that field out, or set it in n8n.");
  }
}

/** What n8n accepts on create/update: anything else in a fetched workflow is rejected by its API. */
const writable = (w: Doc) => ({ name: w.name, nodes: w.nodes, connections: w.connections, settings: w.settings ?? {} });

const server = new McpServer({ name: "n8n", version: "0.1.0" });

server.registerTool("n8n_workflows", {
  description: "List the workflows: id, name, active, tags, last update. Filters by name (substring), tag and active state. The first tool to call.",
  inputSchema: {
    account,
    name: z.string().optional().describe("substring of the name, case-insensitive"),
    tag: z.string().optional(),
    active: z.boolean().optional(),
  },
}, async ({ account, name, tag, active }: { account?: string; name?: string; tag?: string; active?: boolean }) => {
  const q = [active === undefined ? "" : `active=${active}`, tag ? `tags=${encodeURIComponent(tag)}` : ""].filter(Boolean).join("&");
  const ws = await all(account, `/workflows${q ? `?${q}` : ""}`);
  return text(ws
    .filter((w) => !name || String(w.name).toLowerCase().includes(name.toLowerCase()))
    .map((w) => ({ id: w.id, name: w.name, active: w.active, tags: (w.tags ?? []).map((t: Doc) => t.name), updatedAt: w.updatedAt })));
});

server.registerTool("n8n_workflow", {
  description: "One workflow in full: nodes, connections, settings. Values that look secret are masked.",
  inputSchema: { account, id: z.string() },
}, async ({ account, id }: { account?: string; id: string }) => {
  const w = await api(account, `/workflows/${encodeURIComponent(id)}`);
  return text(maskDeep({ id: w.id, active: w.active, tags: (w.tags ?? []).map((t: Doc) => t.name), ...writable(w) }));
});

const workflowShape = {
  name: z.string(),
  nodes: z.array(z.record(z.unknown())).describe("n8n nodes, as in an exported workflow"),
  connections: z.record(z.unknown()).describe("n8n connections, as in an exported workflow"),
  settings: z.record(z.unknown()).optional(),
};

server.registerTool("n8n_create_workflow", {
  description: "Create a workflow (inactive). Returns its id. Credentials are referenced by id/name as in n8n, never inlined.",
  inputSchema: { account, ...workflowShape },
}, async ({ account, ...w }: { account?: string; name: string; nodes: Doc[]; connections: Doc; settings?: Doc }) => {
  refuseMasked(w);
  const r = await api(account, "/workflows", { method: "POST", body: JSON.stringify(writable(w)) });
  return text({ id: r.id, name: r.name, active: r.active });
});

server.registerTool("n8n_update_workflow", {
  description:
    "Replace a workflow's name, nodes, connections and settings (n8n has no partial update). Fetch it with n8n_workflow first and send it back whole; masked values are refused.",
  inputSchema: { account, id: z.string(), ...workflowShape },
}, async ({ account, id, ...w }: { account?: string; id: string; name: string; nodes: Doc[]; connections: Doc; settings?: Doc }) => {
  refuseMasked(w);
  const r = await api(account, `/workflows/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(writable(w)) });
  return text({ id: r.id, name: r.name, active: r.active, updatedAt: r.updatedAt });
});

server.registerTool("n8n_set_active", {
  description: "Activate or deactivate a workflow (its triggers start or stop listening).",
  inputSchema: { account, id: z.string(), active: z.boolean() },
}, async ({ account, id, active }: { account?: string; id: string; active: boolean }) => {
  const r = await api(account, `/workflows/${encodeURIComponent(id)}/${active ? "activate" : "deactivate"}`, { method: "POST" });
  return text({ id: r.id, name: r.name, active: r.active });
});

server.registerTool("n8n_executions", {
  description: "Recent executions, newest first: id, workflow, status, start and end. Filters by workflow and status.",
  inputSchema: {
    account,
    workflowId: z.string().optional(),
    status: z.enum(["success", "error", "waiting", "canceled"]).optional(),
    limit: z.number().int().min(1).max(100).optional().describe("default 20"),
  },
}, async ({ account, workflowId, status, limit }: { account?: string; workflowId?: string; status?: string; limit?: number }) => {
  const q = [`limit=${limit ?? 20}`, workflowId ? `workflowId=${encodeURIComponent(workflowId)}` : "", status ? `status=${status}` : ""].filter(Boolean).join("&");
  const r = await api(account, `/executions?${q}`);
  return text((r.data ?? []).map((e: Doc) => ({ id: e.id, workflowId: e.workflowId, status: e.status, mode: e.mode, startedAt: e.startedAt, stoppedAt: e.stoppedAt })));
});

server.registerTool("n8n_execution", {
  description:
    "One execution. With data=true, what each node produced (masked, and cut to the last items per node): that is where the reason for a failure is.",
  inputSchema: { account, id: z.string(), data: z.boolean().optional(), items: z.number().int().min(1).max(50).optional().describe("items kept per node, default 3") },
}, async ({ account, id, data, items }: { account?: string; id: string; data?: boolean; items?: number }) => {
  const e = await api(account, `/executions/${encodeURIComponent(id)}${data ? "?includeData=true" : ""}`);
  const out: Doc = { id: e.id, workflowId: e.workflowId, status: e.status, mode: e.mode, startedAt: e.startedAt, stoppedAt: e.stoppedAt };
  const run = e.data?.resultData;
  if (run?.error) out.error = { message: run.error.message, node: run.error.node?.name, description: run.error.description };
  if (data && run?.runData) {
    out.nodes = Object.fromEntries(Object.entries(run.runData as Record<string, Doc[]>).map(([node, runs]) => {
      const last = runs.at(-1) ?? {};
      const main = (last.data?.main ?? []).flat().filter(Boolean);
      return [node, { status: last.executionStatus, error: last.error?.message, items: main.length, sample: maskDeep(main.slice(-(items ?? 3)).map((i: Doc) => i.json)) }];
    }));
  }
  return text(out);
});

server.registerTool("n8n_health", {
  description: "Is the instance up, and does the key work: accounts this profile sees, each with its state.",
  inputSchema: {},
}, async () => {
  const out = [];
  for (const a of n8n.visible) {
    try {
      await api(a.name, "/workflows?limit=1");
      out.push({ account: a.name, url: a.url, ok: true });
    } catch (e) {
      out.push({ account: a.name, url: a.url, ok: false, error: (e as Error).message });
    }
  }
  return text(out.length ? out : "no n8n account for this profile");
});

await server.connect(new StdioServerTransport());
