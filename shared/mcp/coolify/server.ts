#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run=/usr/bin/secret-tool
// coolify — MCP server for Coolify instances (accounts.json, service "coolify").
//
// Covers the whole lifecycle of what runs on Coolify: inspect (resources, details, logs, deploy
// history, environment variables, backups), create (projects, environments, applications from git
// or from an image, compose services, databases), change (configuration, domains, variables), run
// (deploy, start, stop, restart, scheduled tasks) and maintain (database backups, Docker cleanup
// on the server). Calls follow the Coolify 4 OpenAPI.
//
// No deletion is exposed, on purpose: destroying a resource is left to a manual action taken in
// Coolify itself.
//
// No secret travels through this server, in either direction. Responses are masked (lib/mask.ts:
// fields, logs, compose files); a variable with a reserved name or an address with embedded
// credentials is rejected on write; a created database returns only its uuid (Coolify answers with
// the clear-text password); for SSH keys only the name is shown, never the content.
//
// Accounts and tokens: shared/mcp/lib (accounts.json + vault). Every tool takes `account`, required
// only when the profile sees more than one instance. The token never goes through a tool.
//
// The HTTP layer and the resolvers are in api.ts; one module per group of tools (inspect, create,
// change, run, maintain), each registering its tools on the server.
import { McpServer } from "npm:@modelcontextprotocol/sdk@1.32.1/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@1.32.1/server/stdio.js";
import { register as registerInspect } from "./inspect.ts";
import { register as registerCreate } from "./create.ts";
import { register as registerChange } from "./change.ts";
import { register as registerRun } from "./run.ts";
import { register as registerMaintain } from "./maintain.ts";

const server = new McpServer({ name: "coolify", version: "0.4.0" });

// The order of registration is the order the tools are listed in.
registerInspect(server);
registerCreate(server);
registerChange(server);
registerRun(server);
registerMaintain(server);

await server.connect(new StdioServerTransport());
