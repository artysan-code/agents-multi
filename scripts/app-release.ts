#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net
/**
 * app-release.ts — the desktop app's half of a release (docs/adr/0004), run by the release workflow
 * after the version's tag is pushed (.forgejo/workflows/release.yml):
 *
 *   app-release.ts check                  release.json and the updater key are filled: a release
 *                                         never goes out with placeholders
 *   app-release.ts prepare <bundle> <out> the bundles `tauri build` left in <bundle> (src-tauri/target/
 *                                         release/bundle), their signatures, under stable names in <out>,
 *                                         and <out>/latest.json: the version's update manifest
 *   app-release.ts publish <out>          the GitHub release of the tag, with <out>'s files (GH_TOKEN);
 *                                         idempotent: what is already there is left as it is
 *   app-release.ts channels <out>/latest.json
 *                                         the site's manifests (apps/site/public/updates/<channel>.json)
 *                                         moved to the version: a stable one on both channels, a beta on
 *                                         beta; never back to an older version
 *   --dry-run                             publish: say what would be sent, send nothing
 *
 * The repository's name, the site and the AUR package are in apps/desktop/release.json, the updater's
 * public key in apps/desktop/src-tauri/tauri.conf.json: renaming or moving the repository changes the
 * manifests' URLs from the next release on, never the installed apps (they only know the site).
 */

import { parseVersion, type Version } from "./release.ts";
import { sectionOf } from "./publish-releases.ts";

export const RELEASE_CONFIG = "apps/desktop/release.json";
export const TAURI_CONFIG = "apps/desktop/src-tauri/tauri.conf.json";
export const UPDATES_DIR = "apps/site/public/updates";
/** The assets' names start with this, whatever the bundle identifier is. */
export const NAME = "agents-multi";
export const CHANNELS = ["stable", "beta"] as const;
export type Channel = typeof CHANNELS[number];

export interface ReleaseConfig {
  /** the project site, which serves /updates/<channel>.json */
  site: string;
  /** owner/name of the GitHub repository whose releases hold the artifacts */
  github: string;
  /** the AUR package's name */
  aur: string;
  /** the SPDX licence the AUR package declares */
  license?: string;
}

export type Kind = "deb" | "rpm" | "appimage";

/** One platform of an update manifest (Tauri's static format). */
export interface Platform {
  url: string;
  signature: string;
}

/** Tauri's static update manifest. */
export interface Manifest {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, Platform>;
}

/** Pure: what is missing for a release, empty when nothing is. */
export function configProblems(release: Partial<ReleaseConfig>, tauri: unknown): string[] {
  const out: string[] = [];
  const pubkey = (tauri as { plugins?: { updater?: { pubkey?: unknown } } })?.plugins?.updater?.pubkey;
  if (!/^https:\/\/[^/\s]+/.test(release.site ?? "")) out.push(`${RELEASE_CONFIG}: "site" is not an https address`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(release.github ?? "")) out.push(`${RELEASE_CONFIG}: "github" is not owner/name`);
  if (typeof pubkey !== "string" || !pubkey.trim()) {
    out.push(`${TAURI_CONFIG}: plugins.updater.pubkey is empty`);
  }
  return out;
}

/** Pure: the kind of a bundle file and whether it is a signature, or null for anything else. */
export function bundleKind(file: string): { kind: Kind; sig: boolean } | null {
  const sig = file.endsWith(".sig");
  const base = sig ? file.slice(0, -4) : file;
  if (base.endsWith(".deb")) return { kind: "deb", sig };
  if (base.endsWith(".rpm")) return { kind: "rpm", sig };
  if (base.endsWith(".AppImage")) return { kind: "appimage", sig };
  return null;
}

/** Pure: the name an asset is published under, the same for every identifier: Debian's, RPM's and
 *  AppImage's conventions, the architecture x86_64 for now (Linux first, ADR 0003). An RPM version
 *  cannot carry a dash: a beta's is `X.Y.Z~beta.N`, which sorts before X.Y.Z. */
export function assetName(kind: Kind, version: string): string {
  if (kind === "deb") return `${NAME}_${version}_amd64.deb`;
  if (kind === "rpm") return `${NAME}-${version.replace("-", "~")}-1.x86_64.rpm`;
  return `${NAME}_${version}_amd64.AppImage`;
}

/** Pure: where a version's asset is downloaded from. */
export function downloadUrl(github: string, version: string, asset: string): string {
  return `https://github.com/${github}/releases/download/v${version}/${encodeURIComponent(asset)}`;
}

/** Pure: a version's manifest. Each package installs its own kind (`linux-x86_64-<kind>`, what the
 *  updater asks for first); the plain `linux-x86_64` is the AppImage, which runs anywhere. */
export function manifestFor(
  version: string,
  notes: string,
  date: Date,
  assets: Partial<Record<Kind, Platform>>,
): Manifest {
  const platforms: Record<string, Platform> = {};
  for (const kind of ["deb", "rpm", "appimage"] as Kind[]) {
    const a = assets[kind];
    if (a) platforms[`linux-x86_64-${kind}`] = a;
  }
  if (assets.appimage) platforms["linux-x86_64"] = assets.appimage;
  return { version, notes, pub_date: date.toISOString().replace(/\.\d{3}Z$/, "Z"), platforms };
}

/** Pure: a < b for versions, a beta before its stable version. */
export function older(a: string, b: string): boolean {
  const k = (v: Version) => [v.major, v.minor, v.patch, v.beta ?? Infinity];
  const x = k(parseVersion(a)), y = k(parseVersion(b));
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/**
 * Pure: the channels' manifests once `release` is out. A stable version goes on stable and, when it
 * is newer than the last beta, on beta too, so a beta never lags behind a stable; a beta goes on beta.
 * A channel never moves back: a rollback is a hand-made commit of the previous manifest (ADR 0004).
 */
export function nextChannels(
  current: Partial<Record<Channel, Manifest>>,
  release: Manifest,
): Partial<Record<Channel, Manifest>> {
  const beta = parseVersion(release.version).beta !== undefined;
  const out: Partial<Record<Channel, Manifest>> = {};
  for (const ch of CHANNELS) {
    if (ch === "stable" && beta) continue;
    const now = current[ch];
    if (!now || older(now.version, release.version)) out[ch] = release;
  }
  return out;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

async function readConfig(): Promise<ReleaseConfig> {
  return await readJson<ReleaseConfig>(RELEASE_CONFIG);
}

async function appVersion(): Promise<string> {
  return (await readJson<{ version: string }>("apps/desktop/package.json")).version;
}

async function check(): Promise<number> {
  const problems = configProblems(await readConfig(), await readJson(TAURI_CONFIG));
  for (const p of problems) console.error(`app-release: ${p}`);
  return problems.length ? 1 : 0;
}

async function* files(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    if (e.isDirectory) yield* files(`${dir}/${e.name}`);
    else if (e.isFile) yield `${dir}/${e.name}`;
  }
}

async function prepare(bundle: string, out: string) {
  const config = await readConfig();
  const version = await appVersion();
  const found: Partial<Record<Kind, { file?: string; sig?: string }>> = {};
  for await (const f of files(bundle)) {
    const k = bundleKind(f);
    if (!k) continue;
    const slot = found[k.kind] ??= {};
    if (slot[k.sig ? "sig" : "file"]) throw new Error(`two ${k.kind} bundles in ${bundle}`);
    slot[k.sig ? "sig" : "file"] = f;
  }
  await Deno.mkdir(out, { recursive: true });
  const assets: Partial<Record<Kind, Platform>> = {};
  for (const kind of ["deb", "rpm", "appimage"] as Kind[]) {
    const f = found[kind];
    if (!f?.file) throw new Error(`no ${kind} bundle in ${bundle}`);
    if (!f.sig) throw new Error(`the ${kind} bundle is not signed (TAURI_SIGNING_PRIVATE_KEY, createUpdaterArtifacts)`);
    const name = assetName(kind, version);
    await Deno.copyFile(f.file, `${out}/${name}`);
    const signature = (await Deno.readTextFile(f.sig)).trim();
    await Deno.writeTextFile(`${out}/${name}.sig`, `${signature}\n`);
    assets[kind] = { url: downloadUrl(config.github, version, name), signature };
  }
  const notes = sectionOf(await Deno.readTextFile("CHANGELOG.md"), version) ?? "";
  const manifest = manifestFor(version, notes, new Date(), assets);
  await Deno.writeTextFile(`${out}/latest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`prepared ${version}: ${Object.keys(assets).join(", ")} in ${out}`);
}

// ---------------------------------------------------------------- GitHub

interface GhRelease {
  id: number;
  tag_name: string;
  draft: boolean;
  upload_url: string;
  assets: { name: string; size: number }[];
}

async function gh(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(path.startsWith("https://") ? path : `https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(init.headers ?? {}),
    },
  });
}

async function ghJson<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const r = await gh(path, token, init);
  if (!r.ok) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${await r.text()}`);
  return await r.json() as T;
}

/** The tag reaches GitHub through the push mirror: a release created before it would make GitHub
 *  create the tag itself, on the default branch's head. */
async function waitForTag(repo: string, tag: string, token: string) {
  for (let i = 0; i < 30; i++) {
    const r = await gh(`/repos/${repo}/git/ref/tags/${tag}`, token);
    await r.body?.cancel();
    if (r.ok) return;
    if (r.status !== 404) throw new Error(`looking for ${tag} on GitHub: ${r.status}`);
    if (i === 0) console.log(`waiting for the mirror to push ${tag} to GitHub…`);
    await new Promise((res) => setTimeout(res, 20_000));
  }
  throw new Error(`${tag} is not on GitHub after ten minutes: is the push mirror syncing on push?`);
}

async function publish(out: string, dry: boolean) {
  const config = await readConfig();
  const manifest = await readJson<Manifest>(`${out}/latest.json`);
  const tag = `v${manifest.version}`;
  const pre = parseVersion(manifest.version).beta !== undefined;
  const names: string[] = [];
  for await (const e of Deno.readDir(out)) if (e.isFile && e.name !== "latest.json") names.push(e.name);
  names.sort();
  if (dry) {
    console.log(`${config.github} ${tag}${pre ? " (pre-release)" : ""}: ${names.join(", ")}`);
    return;
  }
  const token = Deno.env.get("GH_TOKEN");
  if (!token) throw new Error("GH_TOKEN is not set");
  const repo = config.github;
  await waitForTag(repo, tag, token);
  // a draft is not found by its tag: look in the list, drafts included
  const list = await ghJson<GhRelease[]>(`/repos/${repo}/releases?per_page=100`, token);
  let rel = list.find((r) => r.tag_name === tag) ??
    await ghJson<GhRelease>(`/repos/${repo}/releases`, token, {
      method: "POST",
      body: JSON.stringify({ tag_name: tag, name: tag, body: manifest.notes, draft: true, prerelease: pre }),
    });
  for (const name of names) {
    const bytes = await Deno.readFile(`${out}/${name}`);
    const there = rel.assets.find((a) => a.name === name);
    if (there) {
      // a version's files never change: a different one is a mistake, not an update
      if (there.size !== bytes.byteLength) throw new Error(`${name} is already on ${tag} with another size`);
      continue;
    }
    const upload = rel.upload_url.replace(/\{.*\}$/, "");
    await ghJson(`${upload}?name=${encodeURIComponent(name)}`, token, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: bytes,
    });
    console.log(`uploaded ${name}`);
  }
  if (rel.draft) {
    rel = await ghJson<GhRelease>(`/repos/${repo}/releases/${rel.id}`, token, {
      method: "PATCH",
      body: JSON.stringify({ draft: false, prerelease: pre, make_latest: pre ? "false" : "true" }),
    });
  }
  console.log(`published ${tag} on ${repo}`);
}

async function channels(latest: string) {
  const release = await readJson<Manifest>(latest);
  const current: Partial<Record<Channel, Manifest>> = {};
  for (const ch of CHANNELS) {
    current[ch] = await readJson<Manifest>(`${UPDATES_DIR}/${ch}.json`).catch(() => undefined);
  }
  const next = nextChannels(current, release);
  await Deno.mkdir(UPDATES_DIR, { recursive: true });
  for (const [ch, m] of Object.entries(next)) {
    await Deno.writeTextFile(`${UPDATES_DIR}/${ch}.json`, `${JSON.stringify(m, null, 2)}\n`);
    console.log(`${ch} → ${m.version}`);
  }
  if (!Object.keys(next).length) console.log(`no channel moves to ${release.version}`);
}

async function main(args: string[]) {
  const dry = args.includes("--dry-run");
  const [cmd, a, b] = args.filter((x) => !x.startsWith("--"));
  if (cmd === "check") Deno.exit(await check());
  else if (cmd === "prepare" && a && b) await prepare(a, b);
  else if (cmd === "publish" && a) await publish(a, dry);
  else if (cmd === "channels" && a) await channels(a);
  else throw new Error("usage: app-release.ts check | prepare <bundle> <out> | publish <out> | channels <latest.json>");
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (e) {
    console.error(`app-release: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
