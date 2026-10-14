// npm.ts — the npm packages of the registry's third-party MCP servers (`_npm`): installed by
// `agents install` at the pinned version into one prefix (MCP_TOOLS) and started with `node`, so a
// session holds the server and nothing else (`npx` leaves its `npm exec` parent alive for as long as
// the server runs). The version is written in servers.json only; the prefix's package.json is made from it.

import { readJson } from "../lib/fs.ts";
import { run } from "../lib/proc.ts";
import { type NpmPackage, type Registry } from "./registry.ts";
import { reachOf } from "./placement.ts";

/** Pure: the packages the servers in use need, once each, by name. */
export function npmPackages(reg: Pick<Registry, "servers" | "profiles" | "accounts">): NpmPackage[] {
  const out = new Map<string, NpmPackage>();
  for (const cfg of Object.values(reg.servers)) {
    if (cfg._npm && reachOf(reg as Registry, cfg).length && !out.has(cfg._npm.package)) {
      out.set(cfg._npm.package, cfg._npm);
    }
  }
  return [...out.values()].sort((a, b) => a.package.localeCompare(b.package));
}

/** Pure: the package.json of the prefix: every package at its exact version. */
export function toolsPackageJson(pkgs: NpmPackage[]): string {
  const dependencies = Object.fromEntries(pkgs.map((p) => [p.package, p.version]));
  return JSON.stringify(
    { private: true, description: "Installed by agents install: do not edit", dependencies },
    null,
    2,
  ) +
    "\n";
}

/** Pure: what is wrong with a package against what is installed, or null. */
export function npmProblem(p: NpmPackage, installed: string | null, prefix: string): string | null {
  if (installed === p.version) return null;
  const how = "run agents install";
  return installed
    ? `${p.package} ${installed} is installed in ${prefix}, the registry pins ${p.version}: ${how}`
    : `${p.package}@${p.version} is not installed in ${prefix} (the server would not start): ${how}`;
}

/** The version of a package installed in the prefix, or null. */
export async function installedVersion(prefix: string, pkg: string): Promise<string | null> {
  return (await readJson<{ version?: string }>(`${prefix}/node_modules/${pkg}/package.json`))?.version ?? null;
}

/** Brings the prefix to the packages: writes its package.json and runs npm when something differs.
 *  `dry` only reports. Scripts stay off (`--ignore-scripts`): these packages need none, and a
 *  dependency's install script is not something to run unasked.
 *
 *  @returns what it did or would do, one line each; the last may say npm failed */
export async function installNpm(pkgs: NpmPackage[], prefix: string, dry: boolean): Promise<string[]> {
  const todo: string[] = [];
  for (const p of pkgs) {
    if (await installedVersion(prefix, p.package) !== p.version) todo.push(`${p.package}@${p.version}`);
  }
  const text = toolsPackageJson(pkgs);
  const have = await Deno.readTextFile(`${prefix}/package.json`).catch(() => null);
  if (!todo.length && have === text) return [];
  const lines = [`npm install ${todo.join(" ") || "(prune)"} → ${prefix}`];
  if (dry) return lines;
  await Deno.mkdir(prefix, { recursive: true });
  await Deno.writeTextFile(`${prefix}/package.json`, text);
  const r = await run("npm", [
    "install",
    "--prefix",
    prefix,
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--loglevel=error",
  ]);
  if (r.code !== 0) lines.push(`npm install failed (${r.code}): ${r.err.split("\n").slice(-3).join(" | ")}`);
  return lines;
}
