// gateway.ts — the CLI's side of the lazy MCP gateway (docs/adr/0008): which servers go through it, what the
// launch config says for them, what the gateway is told (`backends.json`), its tokens and its tool-list
// cache. The gateway itself is shared/mcp/gateway/; the console keeps it running (console/gateway.ts).

import {
  bearer as _bearer,
  cacheFile,
  cacheKey,
  type GatewayConfig,
  gatewayUrl,
  usableCache,
} from "../../../shared/mcp/gateway/core.ts";
import { writeAtomic } from "../lib/fs.ts";
import { newToken } from "../console/token.ts";
import { isHttp, type Registry } from "./registry.ts";
import { servers, shellQuote } from "./placement.ts";
import { backendsPath, cacheDirOf, type GatewaySettings, tokenFileOf } from "./gateway-settings.ts";

/** Pure: whether a server of the registry goes through the gateway: a command (not a remote server), and
 *  not one the registry keeps on stdio — `_gateway: false` (the hub: it needs the session's folder and
 *  identity) or `_bind` (the project binding is read from the session's folder, which the gateway has not). */
export function viaGateway(cfg: Record<string, unknown>, registryEntry: Record<string, unknown>): boolean {
  return !isHttp(cfg) && registryEntry._gateway !== false && !registryEntry._bind;
}

/** Pure: the entry a profile's launch config holds for a server that goes through the gateway. The
 *  name stays the registry's, so `mcp__<name>__<tool>` and every permission rule stay as they were. */
export function gatewayEntry(g: GatewaySettings, profile: string, name: string): Record<string, unknown> {
  return {
    type: "http",
    url: gatewayUrl(g.port, profile, name),
    headersHelper: `bash ${shellQuote(g.headers)} ${shellQuote(tokenFileOf(profile, g.runtime))}`,
  };
}

/** Pure: the `mcpServers` of a profile's launch config: what `wanted()` says for the CLI, with the servers
 *  that go through the gateway turned into its entries. */
export function launchServers(reg: Registry, profile: string): Record<string, Record<string, unknown>> {
  const g = reg.gateway;
  return Object.fromEntries(
    servers(reg, { profile, surface: "cli" }).map((p) => [
      p.name,
      g?.enabled && viaGateway(p.cfg, reg.servers[p.entry]) ? gatewayEntry(g, profile, p.name) : p.cfg,
    ]),
  );
}

/** Pure: what the gateway starts for a server: its command, arguments and environment, as the plain launch
 *  config would have given them to Claude. */
export function backendSpec(cfg: Record<string, unknown>) {
  return {
    command: String(cfg.command),
    args: ((cfg.args as unknown[] | undefined) ?? []).map(String),
    env: Object.fromEntries(
      Object.entries((cfg.env as Record<string, unknown> | undefined) ?? {}).map(([k, v]) => [k, String(v)]),
    ),
  };
}

/** The gateway's configuration: for each profile its token file and the servers that go through it, each
 *  with the key of its cached tool list. `code` stands for the version of what our own servers run. */
export async function gatewayConfig(reg: Registry, code: string): Promise<GatewayConfig> {
  const g = reg.gateway!;
  const profiles: GatewayConfig["profiles"] = {};
  for (const profile of reg.profiles) {
    const entries: GatewayConfig["profiles"][string]["servers"] = {};
    for (const p of servers(reg, { profile, surface: "cli" })) {
      const def = reg.servers[p.entry];
      if (!viaGateway(p.cfg, def)) continue;
      const spec = backendSpec(p.cfg);
      entries[p.name] = { ...spec, key: await cacheKey(p.name, spec, def._npm?.version ?? code) };
    }
    if (Object.keys(entries).length) {
      profiles[profile] = { tokenFile: tokenFileOf(profile, g.runtime), servers: entries };
    }
  }
  return { port: g.port, idleMs: g.idleMs, profiles };
}

/** A profile's token: made once, in a file only this user reads. @returns true when it was made now. */
export async function ensureToken(path: string): Promise<boolean> {
  const have = (await Deno.readTextFile(path).catch(() => "")).trim();
  const mode = have ? (await Deno.stat(path)).mode! & 0o777 : 0;
  if (have && mode === 0o600) return false;
  if (have) {
    await Deno.chmod(path, 0o600);
    return false;
  }
  await Deno.mkdir(path.replace(/\/[^/]*$/, ""), { recursive: true });
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, newToken() + "\n", { mode: 0o600 });
  await Deno.rename(tmp, path);
  return true;
}

/** Brings the gateway's files in step with the registry: a token per profile that has a server through it,
 *  and backends.json. @returns true when backends.json changed. */
export async function syncGateway(reg: Registry, code: string): Promise<boolean> {
  const g = reg.gateway;
  if (!g?.enabled) return false;
  const cfg = await gatewayConfig(reg, code);
  for (const p of Object.keys(cfg.profiles)) await ensureToken(cfg.profiles[p].tokenFile);
  const text = JSON.stringify(cfg, null, 2) + "\n";
  const path = backendsPath(g.runtime);
  if (await Deno.readTextFile(path).catch(() => null) === text) return false;
  await Deno.mkdir(path.replace(/\/[^/]*$/, ""), { recursive: true, mode: 0o700 });
  await writeAtomic(path, text);
  return true;
}

/** Whether each (profile, server) of the gateway's configuration has its tool list cached. */
export async function cacheState(
  cfg: GatewayConfig,
  runtime: string,
): Promise<{ profile: string; name: string; key: string; cached: boolean }[]> {
  const out = [];
  for (const [profile, p] of Object.entries(cfg.profiles)) {
    for (const [name, s] of Object.entries(p.servers)) {
      const file = cacheFile(cacheDirOf(runtime), name, s.key);
      const hit = usableCache(JSON.parse(await Deno.readTextFile(file).catch(() => "null")), s.key);
      out.push({ profile, name, key: s.key, cached: !!hit });
    }
  }
  return out;
}

/** Pure: the cache files no entry of the configuration names any more (an older version's lists). */
export function staleCacheFiles(files: string[], cfg: GatewayConfig): string[] {
  const live = new Set(
    Object.values(cfg.profiles).flatMap((p) => Object.entries(p.servers).map(([n, s]) => `${n}-${s.key}.json`)),
  );
  return files.filter((f) => f.endsWith(".json") && !live.has(f));
}

/** Pure: the gateway's command line: Deno with the permissions it needs and nothing wider on the network.
 *  It runs the backends (any command of the registry) and hands them the environment, so run and env are
 *  open; what it reads is the runtime, what it writes its own folder. */
export function gatewayCommand(g: GatewaySettings, deno: string, home: string): string[] {
  const dir = `${g.runtime}/shared/mcp/gateway`;
  return [
    deno,
    "run",
    "--quiet",
    "--no-prompt",
    "--no-config",
    `--lock=${dir}/deno.lock`,
    `--allow-net=127.0.0.1:${g.port}`,
    `--allow-read=${g.runtime},${home}/.cache/deno`,
    `--allow-write=${g.runtime}/gateway`,
    "--allow-run",
    "--allow-env",
    "--allow-sys",
    `${dir}/server.ts`,
    backendsPath(g.runtime),
  ];
}
