// core.ts — the pure parts of the lazy MCP gateway (ADR 0008): which request is for which server, who
// may ask, what makes a cached tool list valid, when an idle backend stops. No I/O: the gateway
// (server.ts) and the CLI (apps/cli/mcp/gateway.ts) share it, and apps/cli/tests/gateway_test.ts covers it.

/** How a stdio server is started: the registry entry as the profile's launch config would have it. */
export interface BackendSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}
/** A backend as the gateway is told about it: its spec, and the key of its cached tool list. */
export interface ServerEntry extends BackendSpec {
  key: string;
  /** the registry's `_deny` for this server: tools the gateway neither lists nor forwards */
  deny?: string[];
}
export interface ProfileEntry {
  /** a file only this user reads, holding the profile's token */
  tokenFile: string;
  servers: Record<string, ServerEntry>;
}
/** What the CLI writes for the gateway to read (`<runtime>/gateway/backends.json`). */
export interface GatewayConfig {
  port: number;
  /** a backend with nothing in flight for this long is stopped */
  idleMs: number;
  profiles: Record<string, ProfileEntry>;
}

/** What a backend said about itself, kept so a session opens without starting it. */
export interface CachedList {
  key: string;
  at: string;
  tools: unknown[];
  instructions?: string;
}

/** Pure: the (profile, server) a URL path names: `/p/<profile>/<server>`, nothing else. */
export function parsePath(pathname: string): { profile: string; server: string } | null {
  const m = /^\/p\/(\w[\w.-]*)\/(\w[\w.-]*)\/?$/.exec(pathname);
  return m ? { profile: m[1], server: m[2] } : null;
}

/** Pure: the URL a profile's Claude reaches a server at. */
export const gatewayUrl = (port: number, profile: string, server: string) =>
  `http://127.0.0.1:${port}/p/${profile}/${server}`;

/** Constant time in the length of the longer value (a mismatch says nothing about where it is). */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type Access = "ok" | "unauthorized" | "forbidden";

/** token → profile. A token opens its own profile's paths and no other. */
export class TokenMap {
  #byProfile = new Map<string, string>();
  set(profile: string, token: string) {
    if (token) this.#byProfile.set(profile, token);
    else this.#byProfile.delete(profile);
  }
  /** The profile a token belongs to, or null. Every profile is compared, so the time does not say which. */
  profileOf(token: string): string | null {
    let found: string | null = null;
    for (const [profile, t] of this.#byProfile) if (sameSecret(t, token) && found === null) found = profile;
    return found;
  }
  /** unauthorized: no token or not one we know · forbidden: a real token, another profile's path */
  check(token: string | null | undefined, pathProfile: string): Access {
    const who = token ? this.profileOf(token) : null;
    if (!who) return "unauthorized";
    return who === pathProfile ? "ok" : "forbidden";
  }
}

/** Pure: the `Bearer` token of an Authorization header, or null. */
export function bearer(header: string | null | undefined): string | null {
  const m = /^Bearer ([\w.~+/-]+=*)$/i.exec((header ?? "").trim());
  return m ? m[1] : null;
}

/** Pure: whether the Host header names this listener (a page of another origin reaching 127.0.0.1 by a
 *  name of its own — DNS rebinding — does not), and whether a browser's Origin is absent (it is for a CLI).
 *  The listener is IPv4 loopback only, so `[::1]` is not a name it can be reached by. */
export function localRequest(host: string | null, origin: string | null, port: number): boolean {
  if (origin) return false;
  return !!host && [`127.0.0.1:${port}`, `localhost:${port}`].includes(host.toLowerCase());
}

/** Pure: the tools a server offers once the registry's `_deny` ones are left out. */
export function visibleTools<T extends { name?: unknown }>(tools: T[], deny: string[] | undefined): T[] {
  return deny?.length ? tools.filter((t) => !deny.includes(String(t.name))) : tools;
}
/** Pure: whether a tool may be called through the gateway: the registry's `_deny` is enforced here, on the
 *  server's side, whatever a client's own permission rules say. (`_ask` cannot be: the gateway has no
 *  way to know that a person approved a call.) */
export const toolAllowed = (deny: string[] | undefined, name: string) => !deny?.includes(name);

/** Pure: the start time (clock ticks since boot) in the text of /proc/<pid>/stat, or null. Paired with the
 *  pid it tells a process from another one that was given the pid later. */
export function startTimeOf(stat: string): string | null {
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return rest[19] ?? null;
}

/** What the gateway keeps in `children.json`: the backends it started, to find them again after it died. */
export interface Child {
  pid: number;
  start: string;
  name: string;
}

/** Pure: whether a log of `size` bytes with `add` more would pass `max`. */
export const rotateNeeded = (size: number, add: number, max: number) => size + add > max;

/** Pure: a spec with its env in sorted order, so equal specs serialise equally. */
export function canonical(spec: BackendSpec): string {
  const env = Object.fromEntries(Object.entries(spec.env).sort(([a], [b]) => a < b ? -1 : 1));
  return JSON.stringify({ command: spec.command, args: spec.args, env });
}

/** The key of a cached tool list: the server's name, how it is started (its arguments and environment
 *  carry the tool filters: n8n's DISABLED_TOOLS, supabase's --features) and the version of what it runs
 *  (the npm package's, or the code's). Any of them changing makes the list another one. */
export async function cacheKey(name: string, spec: BackendSpec, version: string): Promise<string> {
  const data = new TextEncoder().encode(`${name}\0${canonical(spec)}\0${version}`);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...hash.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Pure: the file of a cached list. `name` is a registry name (word characters, dots, dashes). */
export const cacheFile = (dir: string, name: string, key: string) => `${dir}/${name}-${key}.json`;

/** Pure: a cached list read from disk, if it is the one for `key`. */
export function usableCache(x: unknown, key: string): CachedList | null {
  const c = x as Partial<CachedList> | null;
  return c && c.key === key && Array.isArray(c.tools) ? c as CachedList : null;
}

/** What the gateway knows about a running backend, to decide on stopping it. */
export interface Activity {
  /** requests forwarded and not yet answered */
  inflight: number;
  /** when it last answered (or started), ms */
  lastUsed: number;
}
/** Pure: an idle backend stops when nothing is in flight and `idleMs` passed since it last worked. */
export const idleDue = (a: Activity, now: number, idleMs: number) => a.inflight === 0 && now - a.lastUsed >= idleMs;
/** Pure: ms until a backend could first be due (the timer sleeps this long), at least a second. */
export const idleCheckIn = (a: Activity, now: number, idleMs: number) => Math.max(1000, a.lastUsed + idleMs - now);

/** Pure: whether the running backend still matches the registry's spec for it. */
export const sameBackend = (running: { key: string } | null, wanted: { key: string } | undefined) =>
  !!running && !!wanted && running.key === wanted.key;
