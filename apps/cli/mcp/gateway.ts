// gateway.ts — the CLI's side of the lazy MCP gateway (docs/adr/0008): which servers go through it, what the
// launch config says for them, what the gateway is told (`backends.json`), its tokens and its tool-list
// cache. The gateway itself is shared/mcp/gateway/; the console keeps it running (console/gateway.ts).

import {
  type CachedList,
  cacheFile,
  cacheKey,
  type GatewayConfig,
  gatewayUrl,
  usableCache,
} from "../../../shared/mcp/gateway/core.ts";
import { describe, startBackend } from "../../../shared/mcp/gateway/backend.ts";
import { writeAtomic } from "../lib/fs.ts";
import { serverCodeVersion, serverDirOf } from "../codeversion.ts";
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
export async function gatewayConfig(
  reg: Registry,
  /** the version of what runs, for a server of ours: by its folder under shared/mcp (null: not one of ours) */
  versionOf: (serverDir: string | null) => Promise<string>,
): Promise<GatewayConfig> {
  const g = reg.gateway!;
  const profiles: GatewayConfig["profiles"] = {};
  for (const profile of reg.profiles) {
    const entries: GatewayConfig["profiles"][string]["servers"] = {};
    for (const p of servers(reg, { profile, surface: "cli" })) {
      const def = reg.servers[p.entry];
      if (!viaGateway(p.cfg, def)) continue;
      const spec = backendSpec(p.cfg);
      const version = def._npm?.version ?? await versionOf(serverDirOf(spec.args));
      entries[p.name] = {
        ...spec,
        key: await cacheKey(p.name, spec, version),
        ...(def._deny?.length ? { deny: [...def._deny].sort() } : {}),
      };
    }
    if (Object.keys(entries).length) {
      profiles[profile] = { tokenFile: tokenFileOf(profile, g.runtime), servers: entries };
    }
  }
  return { port: g.port, idleMs: g.idleMs, profiles };
}

/** The version of one of our servers, once per folder in a run (it reads the files). */
const versions = new Map<string, Promise<string>>();
export const serverVersion = (dir: string | null): Promise<string> =>
  dir ? versions.get(dir) ?? (versions.set(dir, serverCodeVersion(dir)), versions.get(dir)!) : Promise.resolve("");

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
  await writeAtomic(path, newToken() + "\n", { mode: 0o600 });
  return true;
}

/** Brings the gateway's files in step with the registry: a token per profile that has a server through it,
 *  and backends.json. @returns true when backends.json changed. */
export async function syncGateway(reg: Registry): Promise<boolean> {
  const g = reg.gateway;
  if (!g?.enabled) return false;
  const cfg = await gatewayConfig(reg, serverVersion);
  for (const p of Object.keys(cfg.profiles)) await ensureToken(cfg.profiles[p].tokenFile);
  const text = JSON.stringify(cfg, null, 2) + "\n";
  const path = backendsPath(g.runtime);
  if (await Deno.readTextFile(path).catch(() => null) === text) return false;
  await Deno.mkdir(path.replace(/\/[^/]*$/, ""), { recursive: true, mode: 0o700 });
  await writeAtomic(path, text);
  return true;
}

/** The list in a cache file if it is there, valid, and the one for `key`: a missing or damaged file is none. */
async function cachedList(file: string, key: string) {
  try {
    return usableCache(JSON.parse(await Deno.readTextFile(file)), key);
  } catch {
    return null;
  }
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
      out.push({ profile, name, key: s.key, cached: !!await cachedList(file, s.key) });
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

/** Builds the tool lists the cache lacks by starting each server once and asking it (what the gateway does
 *  on a first start, without waiting for a session to pay for it). Lists no entry names are removed.
 *  @returns what was built, and what could not be (name: reason) */
export async function warmCache(
  cfg: GatewayConfig,
  runtime: string,
  opts: { dry?: boolean; force?: boolean } = {},
): Promise<{ built: string[]; failed: string[]; removed: string[] }> {
  const dir = cacheDirOf(runtime);
  const out = { built: [] as string[], failed: [] as string[], removed: [] as string[] };
  const seen = new Set<string>();
  for (const p of Object.values(cfg.profiles)) {
    for (const [name, s] of Object.entries(p.servers)) {
      const file = cacheFile(dir, name, s.key);
      if (seen.has(file)) continue;
      seen.add(file);
      if (!opts.force && await cachedList(file, s.key)) continue;
      if (opts.dry) {
        out.built.push(name);
        continue;
      }
      try {
        const r = await startBackend(s, Deno.env.toObject());
        try {
          const list = await describe(r.client);
          await Deno.mkdir(dir, { recursive: true });
          const body: CachedList = { key: s.key, at: new Date().toISOString(), ...list };
          await writeAtomic(file, JSON.stringify(body));
          out.built.push(`${name} (${list.tools.length} tools)`);
        } finally {
          await r.close();
        }
      } catch (e) {
        out.failed.push(`${name}: ${(e as Error).message}`);
      }
    }
  }
  const files: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile) files.push(e.name);
  } catch { /* no cache folder yet */ }
  for (const f of staleCacheFiles(files, cfg)) {
    if (!opts.dry) await Deno.remove(`${dir}/${f}`).catch(() => {});
    out.removed.push(f);
  }
  return out;
}
