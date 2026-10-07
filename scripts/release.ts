#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run=git
/**
 * release.ts — cuts a version: bumps every manifest, prepends the CHANGELOG section generated from
 * the Conventional Commits since the last tag, commits `chore(release): vX.Y.Z` and tags it.
 * Nothing is pushed; the script prints the push command.
 *
 *   deno task release                 the bump the commits call for (breaking → major, feat → minor, else patch)
 *   deno task release minor           an explicit major | minor | patch
 *   deno task release beta            the next beta pre-release of the coming version (X.Y.Z-beta.N)
 *   deno task release --dry-run       print the version and the section, change nothing
 *   release.ts --lint                 every commit since the last tag is a Conventional Commit (CI)
 *   release.ts --lint-subject "<s>"   one subject (the commit-msg hook)
 *
 * Channels follow branches: a stable version is cut on `release`, a beta on `beta`.
 *
 * When the repository is the one the runtime runs (~/.agents-multi/shared links into it), the console
 * and the tray app still hold the code from before the merge: they are restarted if it changed since
 * the last tag, as self-update does after a pull.
 */

import { staleUnits } from "../apps/cli/lib/stale.ts";
import { amEnv } from "../shared/mcp/lib/env.ts";
import { runtimeRoot } from "../apps/cli/lib/runtime-root.ts";

/** The manifests that carry the version, relative to the repository root. */
export const MANIFESTS = ["deno.json", "apps/site/package.json", "apps/ui/package.json"];

export type Bump = "major" | "minor" | "patch" | "beta";

export interface Version {
  major: number;
  minor: number;
  patch: number;
  beta?: number;
}

export function parseVersion(s: string): Version {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a version: ${s}`);
  const v: Version = { major: +m[1], minor: +m[2], patch: +m[3] };
  if (m[4] !== undefined) v.beta = +m[4];
  return v;
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.beta === undefined ? "" : `-beta.${v.beta}`}`;
}

/**
 * The next version. Raising a component resets every one to its right (0.1.24 → 0.2.0 → 1.0.0).
 * `beta` opens the first beta of the version `target` would cut (0.2.0 → 0.3.0-beta.1) or adds one
 * to a running beta; any stable bump from a beta releases the version the beta was for.
 */
export function bump(v: Version, kind: Bump, target: Exclude<Bump, "beta"> = "patch"): Version {
  if (kind === "beta") return v.beta === undefined ? { ...bump(v, target), beta: 1 } : { ...v, beta: v.beta + 1 };
  if (v.beta !== undefined) return { major: v.major, minor: v.minor, patch: v.patch };
  if (kind === "major") return { major: v.major + 1, minor: 0, patch: 0 };
  if (kind === "minor") return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

export interface Change {
  type: string;
  scope?: string;
  breaking: boolean;
  description: string;
  hash: string;
}

const HEADER = /^(\w+)(?:\(([^)]+)\))?(!)?: (.+)$/;

/** The commit types a subject may start with. */
export const TYPES = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "security",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "style",
  "revert",
];

/** Subjects git writes itself, accepted as they are. */
const GENERATED = /^(Merge |Revert "|fixup! |squash! |amend! )/;

/** Why a subject is not a valid Conventional Commit, or null when it is. */
export function lintSubject(subject: string): string | null {
  if (GENERATED.test(subject)) return null;
  const m = HEADER.exec(subject);
  if (!m) return "the subject is not <type>(<scope>)!: <description>";
  if (!TYPES.includes(m[1])) return `unknown type "${m[1]}" (${TYPES.join(", ")})`;
  if (m[2] !== undefined && !/^[a-z0-9][a-z0-9/._-]*$/.test(m[2])) return `scope "${m[2]}" is not lowercase`;
  if (subject.length > 100) return `the subject is ${subject.length} characters, at most 100`;
  return null;
}

/** A Conventional Commit, or null for a subject that is not one (merges, old history). */
export function parseCommit(c: Commit): Change | null {
  const m = HEADER.exec(c.subject);
  if (!m) return null;
  return {
    type: m[1],
    scope: m[2],
    breaking: m[3] === "!" || /^BREAKING[ -]CHANGE: /m.test(c.body),
    description: m[4],
    hash: c.hash,
  };
}

/**
 * The tag a new version's changes are counted from: the newest stable version for a stable
 * release, so its CHANGELOG section covers everything since the previous stable one, betas
 * included; the newest version of any kind for a beta. Null when there is none.
 */
export function baseTag(tags: string[], forBeta: boolean): string | null {
  const versions = tags.flatMap((t) => {
    try {
      return [{ tag: t, v: parseVersion(t) }];
    } catch {
      return [];
    }
  }).filter((x) => forBeta || x.v.beta === undefined);
  versions.sort((a, b) =>
    b.v.major - a.v.major || b.v.minor - a.v.minor || b.v.patch - a.v.patch ||
    (b.v.beta ?? Infinity) - (a.v.beta ?? Infinity)
  );
  return versions[0]?.tag ?? null;
}

/** The bump a set of changes calls for. Before 1.0.0 a breaking change raises the minor. */
export function impliedBump(changes: Change[], current: Version): Exclude<Bump, "beta"> {
  if (changes.some((c) => c.breaking)) return current.major === 0 ? "minor" : "major";
  if (changes.some((c) => c.type === "feat")) return "minor";
  return "patch";
}

/** CHANGELOG sections, in order; types missing here (ci, chore, test, style, build) are left out. */
const SECTIONS: [string, (c: Change) => boolean][] = [
  ["Breaking changes", (c) => c.breaking],
  ["Added", (c) => !c.breaking && c.type === "feat"],
  ["Fixed", (c) => !c.breaking && c.type === "fix"],
  ["Performance", (c) => !c.breaking && c.type === "perf"],
  ["Changed", (c) => !c.breaking && (c.type === "refactor" || c.type === "revert")],
  ["Security", (c) => !c.breaking && c.type === "security"],
  ["Documentation", (c) => !c.breaking && c.type === "docs"],
];

export function changelogSection(version: string, date: string, changes: Change[]): string {
  const out = [`## [${version}] - ${date}`, ""];
  for (const [title, take] of SECTIONS) {
    const items = changes.filter(take);
    if (!items.length) continue;
    out.push(`### ${title}`, "");
    for (const c of items) out.push(`- ${c.scope ? `**${c.scope}**: ` : ""}${c.description} (${c.hash.slice(0, 7)})`);
    out.push("");
  }
  if (out.length === 2) out.push("No user-facing changes.", "");
  return out.join("\n");
}

/** Inserts a section above the newest one, below the file's preamble. */
export function prependSection(changelog: string, section: string): string {
  const i = changelog.search(/^## \[/m);
  if (i < 0) return `${changelog.trimEnd()}\n\n${section}`;
  return `${changelog.slice(0, i)}${section}\n${changelog.slice(i)}`;
}

/** Replaces the top-level "version" of a JSON manifest, keeping its layout. */
export function setManifestVersion(json: string, version: string): string {
  if (!/^\s*\{/.test(json)) throw new Error("manifest is not a JSON object");
  if (/^ {2}"version":\s*"[^"]*"/m.test(json)) {
    return json.replace(/^( {2}"version":\s*)"[^"]*"/m, `$1"${version}"`);
  }
  return json.replace(/^\{\n/, `{\n  "version": "${version}",\n`);
}

async function git(...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args, stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim()}`);
  return new TextDecoder().decode(out.stdout).trim();
}

/** Whether `root` is the checkout the runtime runs: ~/.agents-multi/shared is a link into it. */
async function isRuntime(root: string): Promise<boolean> {
  const runtime = amEnv("ROOT") ?? runtimeRoot(Deno.env.get("HOME") ?? "");
  return await Deno.realPath(`${runtime}/shared`).then((p) => p === `${root}/shared`, () => false);
}

/** Restarts the console and the tray app when the code they run changed since `tag`. */
async function restartStale(root: string, tag: string | null) {
  if (!tag || !(await isRuntime(root))) return;
  const units = staleUnits((await git("diff", "--name-only", tag, "HEAD")).split("\n").filter(Boolean));
  if (!units.length) return;
  const out = await new Deno.Command("systemctl", { args: ["--user", "--no-block", "try-restart", ...units] })
    .output().catch(() => null);
  console.log(out?.success ? `restarted ${units.join(", ")}` : `could not restart ${units.join(", ")}`);
}

async function commitsSince(tag: string | null): Promise<Commit[]> {
  const range = tag ? [`${tag}..HEAD`] : ["HEAD"];
  const raw = await git("log", "--no-merges", "--format=%H%x1f%s%x1f%b%x1e", ...range);
  return raw.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, subject, body = ""] = r.split("\x1f");
    return { hash, subject, body };
  });
}

async function lint(args: string[]): Promise<number> {
  const at = args.indexOf("--lint-subject");
  const subjects = at >= 0
    ? [{ hash: "", subject: args[at + 1] ?? "", body: "" }]
    : await commitsSince(baseTag((await git("tag", "--list", "v*", "--merged", "HEAD")).split("\n"), true));
  let bad = 0;
  for (const c of subjects) {
    const why = lintSubject(c.subject);
    if (!why) continue;
    bad++;
    console.error(`${c.hash ? `${c.hash.slice(0, 7)} ` : ""}${c.subject}\n  ${why}`);
  }
  if (bad) {
    console.error("\nWrite subjects as <type>(<scope>)!: <description>, e.g. feat(brain): rate limit on sign-in");
  }
  return bad ? 1 : 0;
}

async function main(args: string[]) {
  if (args.some((a) => a.startsWith("--lint"))) Deno.exit(await lint(args));
  const dry = args.includes("--dry-run");
  const kind = args.find((a) => !a.startsWith("--")) as Bump | undefined;
  if (kind && !["major", "minor", "patch", "beta"].includes(kind)) throw new Error(`unknown bump: ${kind}`);

  const root = await git("rev-parse", "--show-toplevel");
  Deno.chdir(root);
  if (!dry && (await git("status", "--porcelain"))) throw new Error("the working tree is not clean");

  const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
  const wanted = kind === "beta" ? "beta" : "release";
  if (!dry && branch !== wanted) {
    throw new Error(`a ${kind === "beta" ? "beta" : "stable"} version is cut on ${wanted}, not ${branch}`);
  }

  const current = parseVersion(JSON.parse(await Deno.readTextFile("deno.json")).version);
  const tags = (await git("tag", "--list", "v*", "--merged", "HEAD")).split("\n").filter(Boolean);
  const lastTag = baseTag(tags, kind === "beta");
  const changes = (await commitsSince(lastTag)).map(parseCommit).filter((c): c is Change => c !== null);
  const target = impliedBump(changes, current);
  const next = formatVersion(bump(current, kind ?? target, target));
  const date = new Date().toISOString().slice(0, 10);
  const section = changelogSection(next, date, changes);

  console.log(
    `${formatVersion(current)} → ${next} (${changes.length} conventional commits since ${lastTag ?? "the start"})\n`,
  );
  console.log(section);
  if (dry) return;

  for (const m of MANIFESTS) await Deno.writeTextFile(m, setManifestVersion(await Deno.readTextFile(m), next));
  const changelog = await Deno.readTextFile("CHANGELOG.md");
  await Deno.writeTextFile("CHANGELOG.md", prependSection(changelog, section));
  await git("add", "CHANGELOG.md", ...MANIFESTS);
  await git("commit", "-q", "-m", `chore(release): v${next}`);
  await git("tag", "-a", `v${next}`, "-m", `v${next}`);
  console.log(`tagged v${next}. Publish with: git push origin ${branch} v${next}`);
  await restartStale(root, lastTag);
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (e) {
    console.error(`release: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
