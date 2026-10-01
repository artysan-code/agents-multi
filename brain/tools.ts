// tools.ts — what Claude can do with the brain, as MCP tools: find, read, write and look back
// through the documents, plus the task tools (shared/mcp/tasks/tools.ts) on the tasks kept here.
//
// Every tool says plainly whether it only reads or changes something (annotations), so a client
// that asks before changes — claude.ai's "needs approval" — asks for exactly those.

import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { z } from "npm:zod@^3.23";
import { registerTaskTools } from "../shared/mcp/tasks/tools.ts";
import type { Store } from "./store.ts";
import { type EmbedConfig, fuse, searchMeaning } from "./embed.ts";

export const INSTRUCTIONS =
  "Samuel's brain: his memory (Markdown documents with a path, linked with [[path]]) and his tasks. " +
  "Before assuming anything about Samuel, his projects, preferences or tools, search here (brain_search) and read what you find. " +
  "Write here what is durable and worth remembering across conversations, in the place and form the existing documents use: " +
  "read a document before changing it, prefer brain_edit for a change inside one, and say in one line what you wrote. " +
  "Never write secrets, credentials or clients' data. Tasks: follow the task tools' descriptions.";

const text = (o: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(o, null, 2) }] });
const READ = { readOnlyHint: true, openWorldHint: false };
const CHANGE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

export interface ToolContext { store: Store; embed: EmbedConfig; by: () => string; changed: () => void }

/** Words and meaning together; when the model is unreachable, words alone, and the answer says so. */
export async function search(ctx: ToolContext, query: string, limit = 10, tasks = false) {
  const words = ctx.store.searchWords(query, 30, tasks);
  let meaning: Awaited<ReturnType<typeof searchMeaning>> = [], note: string | undefined;
  try { meaning = await searchMeaning(ctx.store, ctx.embed, query, 30, tasks); } catch (e) { note = `meaning search unavailable (${(e as Error).message}): words only`; }
  const order = fuse([words.map((w) => w.path), meaning.map((m) => m.path)]).slice(0, limit);
  const results = order.map((path) => {
    const w = words.find((x) => x.path === path), m = meaning.find((x) => x.path === path);
    const title = w?.title ?? ctx.store.get(path)?.title ?? path;
    return { path, title, excerpt: w?.snippet ?? m?.text.slice(0, 300) ?? "" };
  });
  return { results, ...(note ? { note } : {}) };
}

export function brainServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "brain", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const { store } = ctx;

  server.registerTool("brain_search", {
    description: "Search Samuel's memory by words and by meaning. Returns paths, titles and an excerpt: read the documents that matter with brain_read.",
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).optional(), include_tasks: z.boolean().optional() },
    annotations: READ,
  }, async ({ query, limit, include_tasks }: { query: string; limit?: number; include_tasks?: boolean }) => text(await search(ctx, query, limit, include_tasks)));

  server.registerTool("brain_read", {
    description: "A document in full: its Markdown, its revision number (pass it as base_rev when you change it), and its links both ways. With rev, how it was then.",
    inputSchema: { path: z.string(), rev: z.number().int().min(1).optional() },
    annotations: READ,
  }, ({ path, rev }: { path: string; rev?: number }) => {
    if (rev) {
      const r = store.revision(path, rev);
      if (!r) throw new Error(`no version ${rev} of ${path}`);
      return text(r);
    }
    const d = store.get(path) ?? (store.resolve(path) ? store.get(store.resolve(path)!) : null);
    if (!d) throw new Error(`no document ${path}: search for it with brain_search, or list a folder with brain_list`);
    return text({ ...d, links: store.links(d.path) });
  });

  server.registerTool("brain_list", {
    description: "The documents under a folder (everything when no folder), newest first: path, title, revision, when and by whom.",
    inputSchema: { folder: z.string().optional(), limit: z.number().int().min(1).max(1000).optional() },
    annotations: READ,
  }, ({ folder, limit }: { folder?: string; limit?: number }) => {
    const prefix = folder ? folder.replace(/^\/+|\/+$/g, "") + "/" : "";
    return text({ folder: prefix || "/", documents: store.list(prefix, { limit: limit ?? 200 }) });
  });

  server.registerTool("brain_write", {
    description: "Create a document, or replace one whole. To replace, read it first and pass its rev as base_rev: if it changed meanwhile the write is refused. " +
      "The previous version is kept (brain_history).",
    inputSchema: { path: z.string().describe("folder/name.md"), body: z.string().describe("the whole Markdown"), base_rev: z.number().int().min(0).optional().describe("the rev you read; 0 to create only if it does not exist") },
    annotations: CHANGE,
  }, ({ path, body, base_rev }: { path: string; body: string; base_rev?: number }) => {
    const d = store.write(path, body, ctx.by(), base_rev);
    ctx.changed();
    return text({ written: d.path, rev: d.rev, title: d.title });
  });

  server.registerTool("brain_edit", {
    description: "Change part of a document: replace one exact passage with another (it must occur exactly once). Cheaper and safer than rewriting the whole document.",
    inputSchema: { path: z.string(), find: z.string().min(1), replace: z.string(), base_rev: z.number().int().min(1).optional() },
    annotations: CHANGE,
  }, ({ path, find, replace, base_rev }: { path: string; find: string; replace: string; base_rev?: number }) => {
    const d = store.get(path);
    if (!d) throw new Error(`no document ${path}`);
    const n = d.body.split(find).length - 1;
    if (n !== 1) throw new Error(n ? `the passage occurs ${n} times: include more context` : "the passage is not in the document: read it again");
    const w = store.write(d.path, d.body.replace(find, () => replace), ctx.by(), base_rev ?? d.rev);
    ctx.changed();
    return text({ edited: w.path, rev: w.rev });
  });

  server.registerTool("brain_delete", {
    description: "Remove a document from the brain. Its history stays, and brain_restore brings it back.",
    inputSchema: { path: z.string() },
    annotations: { ...CHANGE, destructiveHint: true },
  }, ({ path }: { path: string }) => {
    store.remove(path, ctx.by());
    ctx.changed();
    return text({ removed: path });
  });

  server.registerTool("brain_history", {
    description: "The versions of a document: revision, when, by whom (Samuel, or Claude from which client), and what happened.",
    inputSchema: { path: z.string() },
    annotations: READ,
  }, ({ path }: { path: string }) => text({ path, versions: store.history(path) }));

  server.registerTool("brain_restore", {
    description: "Put an earlier version of a document back (as a new version on top: nothing is lost).",
    inputSchema: { path: z.string(), rev: z.number().int().min(1) },
    annotations: CHANGE,
  }, ({ path, rev }: { path: string; rev: number }) => {
    const d = store.restore(path, rev, ctx.by());
    ctx.changed();
    return text({ restored: d.path, from: rev, rev: d.rev });
  });

  registerTaskTools(server);
  return server;
}
