// placement.ts — pure: which servers each profile and surface gets from the registry, under what
// name and config, and what the registry implies for permissions. No I/O.

import { type Account, accountHosts, visibleAccounts } from "../../../shared/mcp/lib/accounts.ts";
import { amEnvBoth } from "../../../shared/mcp/lib/env.ts";
import { HOME } from "../lib/paths.ts";
import { type Profile } from "../lib/profiles.ts";
import { isHttp, type LaunchPaths, launchPaths, type Registry, type ServerCfg, type Surface } from "./registry.ts";

export interface Target {
  profile: Profile;
  surface: Surface;
  path: string;
  managedKey: string;
}

/** The profiles a server reaches: its _profiles, and for an account-backed one only those that see
 *  one of its accounts (what wanted() applies, and what status and health report). */
export function reachOf(reg: Registry, cfg: ServerCfg): string[] {
  return (cfg._profiles ?? reg.profiles).filter((p) =>
    !cfg._service || visibleAccounts(reg.accounts ?? [], cfg._service, p).length
  );
}

/** Pure: a value with {url} {host} {name} {hosts} replaced by the account's. {secret} is left alone. */
export function forAccount<T>(v: T, a: Account): T {
  let host = "";
  try {
    host = a.url ? new URL(a.url).host : "";
  } catch { /* an invalid address has no host */ }
  const sub = (s: string) =>
    s.replaceAll("{url}", a.url ?? "").replaceAll("{hosts}", host || "127.0.0.1:9").replaceAll("{host}", host)
      .replaceAll("{name}", a.name);
  const walk = (x: unknown): unknown =>
    typeof x === "string"
      ? sub(x)
      : Array.isArray(x)
      ? x.map(walk)
      : x && typeof x === "object"
      ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]))
      : x;
  return walk(v) as T;
}

/** Pure: one word for a POSIX shell. */
export const shellQuote = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;

/** Pure: the deno command line of launch.ts, allowed to run `run` and nothing else. */
export function launcher(paths: LaunchPaths, run?: string, bind = false): string[] {
  return [
    "deno",
    "run",
    "--quiet",
    "--no-lock",
    // a binding is looked for from the session's folder up to the home folder
    `--allow-read=${(bind ? [...paths.read, HOME] : paths.read).join(",")}`,
    "--allow-env=HOME,AGENTS_MULTI_PROFILE,CLAUDE_MULTI_PROFILE,AGENTS_MULTI_VAULT,CLAUDE_MULTI_VAULT,AGENTS_MULTI_ACCOUNTS,CLAUDE_MULTI_ACCOUNTS",
    `--allow-run=/usr/bin/secret-tool${run ? `,${run}` : ""}`,
    paths.script,
  ];
}

/** Pure: a `_perAccount` entry made into one server for one account (name and config). */
export function perAccount(
  reg: Registry,
  name: string,
  cfg: ServerCfg,
  clean: Record<string, unknown>,
  a: Account,
  t: Pick<Target, "profile" | "surface">,
): [string, Record<string, unknown>] {
  const paths = reg.launch ?? launchPaths();
  const out = forAccount(clean, a);
  const tpl = forAccount(cfg._perAccount ?? {}, a);
  const service = cfg._service!;
  if (isHttp(out)) {
    const headers = Object.entries(tpl.headers ?? {}).map(([k, v]) => `${k}=${v}`);
    // Claude Code runs it through a shell, with its own env: the profile goes on the line
    if (headers.length) {
      out.headersHelper = [
        `AGENTS_MULTI_PROFILE=${shellQuote(t.profile)}`,
        `CLAUDE_MULTI_PROFILE=${shellQuote(t.profile)}`,
        ...launcher(paths),
        "headers",
        service,
        a.name,
        ...headers,
      ].map((w, i) => i ? shellQuote(w) : w).join(" ");
    }
  } else {
    const env = Object.entries(tpl.env ?? {});
    if (env.length) {
      const cmd = String(out.command);
      const binds = Object.entries(cfg._bind ?? {}).flatMap(([k, v]) => ["--bind", `${k}=${v}`]);
      out.args = [
        ...launcher(paths, cmd, binds.length > 0).slice(1),
        "run",
        service,
        a.name,
        ...env.flatMap(([k, v]) => ["--env", `${k}=${v}`]),
        ...binds,
        "--",
        cmd,
        ...(out.args as string[] ?? []),
      ];
      out.command = "deno";
    }
    out.env = { ...(out.env as Record<string, string> ?? {}), ...amEnvBoth("PROFILE", t.profile) };
    if (t.surface === "desktop" && reg.bus) (out.env as Record<string, string>).DBUS_SESSION_BUS_ADDRESS = reg.bus;
  }
  return [`${name}-${a.name}`, out];
}

/** One server a target gets: the registry entry it comes from, the name it has there, the accounts it works on. */
export interface Placed {
  entry: string;
  name: string;
  cfg: Record<string, unknown>;
  accounts: string[];
}

/** Pure: the servers one target gets, each with the registry entry it comes from. */
export function servers(reg: Registry, t: Pick<Target, "profile" | "surface">): Placed[] {
  const out: Placed[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const profiles = cfg._profiles ?? reg.profiles;
    const surfaces = cfg._surfaces ?? ["cli"];
    if (!profiles.includes(t.profile) || !surfaces.includes(t.surface)) continue;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) if (!k.startsWith("_")) clean[k] = v;
    if (cfg._perAccount && cfg._service) {
      if (t.surface === "desktop" && isHttp(clean)) continue; // Desktop's config holds commands only
      for (const a of visibleAccounts(reg.accounts ?? [], cfg._service, t.profile)) {
        const [n, c] = perAccount(reg, name, cfg, clean, a, t);
        if (t.surface === "desktop") delete c.type;
        out.push({ entry: name, name: n, cfg: c, accounts: [a.name] });
      }
      continue;
    }
    if (cfg._service) {
      const visible = visibleAccounts(reg.accounts ?? [], cfg._service, t.profile);
      if (!visible.length) continue; // nothing this profile could use it for
      // with no address at all, reach nothing rather than everything
      const hosts = accountHosts(visible).join(",") || "127.0.0.1:9";
      if (Array.isArray(clean.args)) {
        clean.args = clean.args.map((a) => typeof a === "string" ? a.replaceAll("{hosts}", hosts) : a);
      }
      if (isHttp(clean)) {
        // a remote server at the account's address ({url}): the person's own brain, not anyone's written in
        if (visible.length !== 1) continue; // which one would it be? accounts.json must say, with profiles
        out.push({ entry: name, name, cfg: forAccount(clean, visible[0]), accounts: [visible[0].name] });
        continue;
      }
      clean.env = { ...(clean.env as Record<string, string> ?? {}), ...amEnvBoth("PROFILE", t.profile) };
      // a work profile sees only its part of the brain (manifest brainScope)
      const scope = cfg._service === "brain" ? reg.brainScopes?.[t.profile] : undefined;
      if (scope) Object.assign(clean.env as Record<string, string>, amEnvBoth("BRAIN_SCOPE", scope));
      if (t.surface === "desktop" && reg.bus) (clean.env as Record<string, string>).DBUS_SESSION_BUS_ADDRESS = reg.bus;
    }
    if (t.surface === "desktop") delete clean.type; // Desktop takes command/args/env; "type" is CLI vocabulary
    const accounts = cfg._service
      ? visibleAccounts(reg.accounts ?? [], cfg._service, t.profile).map((a) => a.name)
      : [];
    out.push({ entry: name, name, cfg: clean, accounts });
  }
  return out;
}

/** Pure: every server the registry places, per profile and surface, under the name it has there. */
export function placements(
  reg: Registry,
): { entry: string; name: string; profile: string; surface: Surface; service?: string; accounts: string[] }[] {
  return reg.profiles.flatMap((profile) =>
    (["cli", "desktop"] as const).flatMap((surface) =>
      servers(reg, { profile, surface }).map(({ entry, name, accounts }) => ({
        entry,
        name,
        profile,
        surface,
        service: reg.servers[entry]._service,
        accounts,
      }))
    )
  );
}

/** What one profile has mounted at its last sync: CLI servers, and Desktop's (null: never opened). */
export interface Mounted {
  cli: string[];
  desktop: string[] | null;
}
/** Where one account (or one server that needs none) reaches: the profiles that get it, those still
 *  waiting for a sync, those waiting for their Desktop to be opened once (not wrong: sync applies then). */
export interface Reach {
  profiles: string[];
  pending: string[];
  noDesktop: string[];
}

/** Pure: Reach per account (`service/name`) and per server without accounts (`server/entry`),
 *  against what each profile mounted. `desktop` false: no Claude Desktop here, its places do not count. */
export function reach(
  places: ReturnType<typeof placements>,
  mounted: Record<string, Mounted>,
  desktop: boolean,
): Record<string, Reach> {
  const out: Record<string, { profiles: Set<string>; pending: Set<string>; noDesktop: Set<string> }> = {};
  const at = (k: string) => out[k] ??= { profiles: new Set(), pending: new Set(), noDesktop: new Set() };
  for (const pl of places) {
    if (pl.surface === "desktop" && !desktop) continue;
    const keys = pl.service ? pl.accounts.map((a) => `${pl.service}/${a}`) : [`server/${pl.entry}`];
    const m = mounted[pl.profile];
    const have = pl.surface === "cli" ? m?.cli : m?.desktop;
    for (const k of keys) {
      const r = at(k);
      r.profiles.add(pl.profile);
      if (pl.surface === "desktop" && m && m.desktop === null) r.noDesktop.add(pl.profile);
      else if (!have?.includes(pl.name)) r.pending.add(pl.profile);
    }
  }
  const sorted = (x: Set<string>) => [...x].sort();
  return Object.fromEntries(
    Object.entries(out).map((
      [k, r],
    ) => [k, { profiles: sorted(r.profiles), pending: sorted(r.pending), noDesktop: sorted(r.noDesktop) }]),
  );
}

/**
 * Pure: the `mcpServers` object one target should hold.
 *
 * @param reg the loaded registry
 * @param t the profile and surface (cli or desktop) to place servers for
 * @returns server name to its config, `_`-keys removed and account templating applied
 */
export function wanted(reg: Registry, t: Pick<Target, "profile" | "surface">): Record<string, Record<string, unknown>> {
  return Object.fromEntries(servers(reg, t).map((s) => [s.name, s.cfg]));
}
export interface GuardHook {
  matcher: string;
  hooks: { type: "command"; command: string }[];
}
export interface RegistryRules {
  deny: string[];
  ask: string[];
  hooks: GuardHook[];
}

/** Pure: what the registry implies for one profile's settings — `_deny` and `_ask` of every server
 *  it gets on the CLI as permission rules, and each `_guard` as a PreToolUse hook on exactly those
 *  servers, under the name each one has there (one per account, for `_perAccount`). */
export function permissionRules(reg: Registry, profile: string): RegistryRules {
  const deny: string[] = [];
  const ask: string[] = [];
  const guarded = new Map<string, string[]>();
  for (const { entry, name } of servers(reg, { profile, surface: "cli" })) {
    const cfg = reg.servers[entry];
    for (const tool of cfg._deny ?? []) deny.push(`mcp__${name}__${tool}`);
    for (const tool of cfg._ask ?? []) ask.push(`mcp__${name}__${tool}`);
    if (cfg._guard) guarded.set(entry, [...guarded.get(entry) ?? [], `mcp__${name}__${cfg._guard.tool}`]);
  }
  const dir = (reg.launch ?? launchPaths()).hooks;
  const hooks: GuardHook[] = [...guarded].map(([entry, tools]) => ({
    matcher: `^(${tools.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`,
    hooks: [{ type: "command", command: `deno run --quiet --no-lock ${dir}/${reg.servers[entry]._guard!.hook}` }],
  }));
  return { deny: deny.sort(), ask: ask.sort(), hooks };
}
