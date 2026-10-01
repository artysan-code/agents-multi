#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// tasks — MCP server on Samuel's tasks (shared/mcp/lib/tasks.ts): the same list from every
// profile, every surface, every machine. Registered everywhere, so any chat can read the day and
// keep it current: a thing to do said in passing becomes a task, a thing done is marked done.
//
// No deletion: a task that no longer matters is `dropped` (it survives Syncthing, and stays visible
// in the history). Every answer carries today's date and the time, so "tomorrow at ten" resolves to
// a real day.
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";
import { registerTaskTools } from "./tools.ts";

const server = new McpServer({ name: "tasks", version: "0.1.0" });
registerTaskTools(server);
await server.connect(new StdioServerTransport());
