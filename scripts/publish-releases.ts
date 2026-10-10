#!/usr/bin/env -S deno run --allow-read --allow-env --allow-net --allow-run=git
/**
 * publish-releases.ts — a Forgejo release for every version tag that has none yet, with its
 * CHANGELOG section as the notes; a beta or an rc is marked as a pre-release. Run by the release workflow on
 * every tag push (.forgejo/workflows/release.yml), so a tag that was pushed before the workflow
 * existed gets its release on the next one. Idempotent: an existing release is left as it is.
 *
 *   FORGEJO_API=https://host/api/v1 FORGEJO_REPO=owner/name FORGEJO_TOKEN=… deno run … scripts/publish-releases.ts
 *   publish-releases.ts --dry-run    print what it would publish, without the API
 */

import { compareVersion, isPre, parseVersion } from "./release.ts";
import { git } from "./lib/git.ts";

/** Pure: the notes of one version, its CHANGELOG section without the heading; null when missing. */
export function sectionOf(changelog: string, version: string): string | null {
  for (const part of changelog.split(/^## \[/m).slice(1)) {
    const m = /^([^\]]+)\][^\n]*\n/.exec(part);
    if (m && m[1] === version) return part.slice(m[0].length).trim();
  }
  return null;
}

/** Pure: the version tags (vX.Y.Z, vX.Y.Z-beta.N, vX.Y.Z-rc.N), oldest first, so releases are created in order. */
export function versionTags(tags: string[]): string[] {
  const vs = tags.flatMap((t) => {
    try {
      return [{ t, v: parseVersion(t) }];
    } catch {
      return [];
    }
  }).filter((x) => x.t.startsWith("v"));
  vs.sort((a, b) => compareVersion(a.v, b.v));
  return vs.map((x) => x.t);
}

async function main(args: string[]) {
  const dry = args.includes("--dry-run");
  const env = (k: string) => {
    const v = Deno.env.get(k);
    if (!v && !dry) throw new Error(`${k} is not set`);
    return v ?? "";
  };
  const api = env("FORGEJO_API").replace(/\/$/, ""), repo = env("FORGEJO_REPO"), token = env("FORGEJO_TOKEN");
  const headers = { authorization: `token ${token}`, "content-type": "application/json", accept: "application/json" };
  const changelog = await Deno.readTextFile("CHANGELOG.md");
  for (const tag of versionTags((await git("tag", "--list", "v*")).split("\n"))) {
    const notes = sectionOf(changelog, tag.slice(1)) ?? "No notes for this version.";
    const pre = isPre(parseVersion(tag));
    if (dry) {
      console.log(
        `${tag}${pre ? " (pre-release)" : ""}: ${notes.split("\n").filter((l) => l.startsWith("- ")).length} changes`,
      );
      continue;
    }
    const seen = await fetch(`${api}/repos/${repo}/releases/tags/${tag}`, { headers });
    await seen.body?.cancel();
    if (seen.ok) continue;
    if (seen.status !== 404) throw new Error(`${tag}: GET release answered ${seen.status}`);
    const made = await fetch(`${api}/repos/${repo}/releases`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tag_name: tag, name: tag, body: notes, prerelease: pre, draft: false }),
    });
    if (!made.ok) throw new Error(`${tag}: creating the release answered ${made.status} ${await made.text()}`);
    await made.body?.cancel();
    console.log(`released ${tag}${pre ? " (pre-release)" : ""}`);
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (e) {
    console.error(`publish-releases: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
