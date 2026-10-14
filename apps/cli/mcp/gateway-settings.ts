// gateway-settings.ts — whether the lazy MCP gateway (docs/adr/0008) is on, and its numbers. The person's
// choice is `<config>/gateway.json`; with no file it is on in app mode (the console, always up there,
// supervises it) and off in dev mode (a checkout need not have a console running).
//
//   { "enabled": false }                       the kill switch: the launch config goes back to plain stdio entries
//   { "idleMinutes": 10, "port": 7332 }        what the gateway does with a backend nobody uses · where it listens

import { amEnv } from "../../../shared/mcp/lib/env.ts";
import { readJson } from "../lib/fs.ts";
import { CONFIG, RUNTIME } from "../lib/paths.ts";
import { type Mode } from "../lib/mode.ts";

export interface GatewaySettings {
  enabled: boolean;
  port: number;
  idleMs: number;
  /** the runtime the token files and the gateway's own folder are under */
  runtime: string;
  /** headers.sh: what Claude's `headersHelper` runs */
  headers: string;
}

export const DEFAULT_PORT = 7332;
export const DEFAULT_IDLE_MINUTES = 10;
export const gatewayFile = () => `${CONFIG}/gateway.json`;
export const gatewayDir = (runtime = RUNTIME) => `${runtime}/gateway`;
export const backendsPath = (runtime = RUNTIME) => `${gatewayDir(runtime)}/backends.json`;
export const cacheDirOf = (runtime = RUNTIME) => `${gatewayDir(runtime)}/cache`;
export const tokenFileOf = (profile: string, runtime = RUNTIME) => `${runtime}/${profile}/mcp-token`;

/** Pure: the settings from the person's file (null: none), the mode, and the runtime they apply to. */
export function gatewaySettings(
  file: { enabled?: unknown; idleMinutes?: unknown; port?: unknown } | null,
  mode: Mode,
  runtime = RUNTIME,
  envPort?: string,
): GatewaySettings {
  const num = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
  return {
    enabled: typeof file?.enabled === "boolean" ? file.enabled : mode === "app",
    port: num(Number(envPort), 1024, 65535) ?? num(file?.port, 1024, 65535) ?? DEFAULT_PORT,
    idleMs: (num(file?.idleMinutes, 1, 24 * 60) ?? DEFAULT_IDLE_MINUTES) * 60_000,
    runtime,
    headers: `${runtime}/shared/mcp/gateway/headers.sh`,
  };
}

export async function loadGatewaySettings(mode: Mode): Promise<GatewaySettings> {
  return gatewaySettings(await readJson(gatewayFile()), mode, RUNTIME, amEnv("GATEWAY_PORT"));
}
