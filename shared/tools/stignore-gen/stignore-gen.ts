#!/usr/bin/env -S deno run --quiet --allow-read --allow-write --allow-env --allow-run=notify-send --allow-net=127.0.0.1
// stignore-gen — keeps the git-repository section of every Syncthing folder's .stignore-common current.
//
// Git owns a repository; Syncthing only carries the files git ignores on purpose, which would otherwise
// exist on one machine only: `.env`, `.env.*` (at any depth) and `.claude/settings.local.json`. Every
// repository found inside a sendreceive folder gets the block of `repoBlock()` in the managed section.
// The first matching rule wins, so the re-inclusions come before `/<repo>/*`; excluding the children
// rather than the directory is what lets Syncthing walk in and find them.
//
// The section only grows. A repository cloned on one machine is added there and reaches the other with
// the file; dropping the entries of repositories gone from disk is explicit (`--prune`), otherwise two
// machines holding different sets would rewrite the file back and forth.
// A repository whose root is excluded by hand outside the markers (`/<repo>`, `/<repo>/*`, `/<repo>/**`)
// is left alone. Per-repository exceptions (an extra re-included file, a tracked `.env` to keep out) are
// written by hand ABOVE the markers, so they match first.
//
//   stignore-gen                    dry run: what would change
//   stignore-gen --apply            write (previous copy in ~/.local/state/stignore-gen/) and rescan
//   stignore-gen --apply --quiet    from the timer and the git hook: silent, desktop notification per new repo
//   --prune                         also drop entries whose repository is no longer on this machine
//   --folder <label|id|path>        one folder only
//
// --apply always asks Syncthing to rescan `.stignore-common`: that is also how a file changed on the
// other machine gets its rules loaded here without waiting for the hourly full scan.

export const MARK_BEGIN = "// >>> stignore-gen: git repositories (generated, do not edit between the markers) >>>";
export const MARK_END = "// <<< stignore-gen <<<";
const REPO_TAG = "// repo: ";

export function repoBlock(repo: string): string[] {
  const r = `/${repo}`;
  return [
    `${REPO_TAG}${repo}`,
    `${r}/.claude/worktrees`,
    `${r}/.env.example`,
    `${r}/**/.env.example`,
    `!${r}/.env`,
    `!${r}/.env.*`,
    `!${r}/**/.env`,
    `!${r}/**/.env.*`,
    `!${r}/.claude/settings.local.json`,
    `${r}/*`,
  ];
}

export type Split = { before: string; section: string | null; after: string };
export function split(text: string): Split {
  const a = text.indexOf(MARK_BEGIN), b = text.indexOf(MARK_END);
  if (a < 0 || b < a) return { before: text, section: null, after: "" };
  return {
    before: text.slice(0, a),
    section: text.slice(a + MARK_BEGIN.length, b),
    after: text.slice(b + MARK_END.length),
  };
}

export function listedRepos(section: string | null): string[] {
  if (!section) return [];
  return section.split("\n").filter((l) => l.startsWith(REPO_TAG)).map((l) => l.slice(REPO_TAG.length).trim());
}

/** Repository roots excluded by hand outside the markers: those are not generated. */
export function handManaged(manual: string): Set<string> {
  const out = new Set<string>();
  for (const raw of manual.split("\n")) {
    const l = raw.trim().replace(/^(\(\?[a-z]\))+/i, "");
    if (!l.startsWith("/") || l.startsWith("//")) continue; // comments start with "//" too
    out.add(l.replace(/^\/+/, "").replace(/\/\*\*?$/, "").replace(/\/+$/, ""));
  }
  return out;
}

export function render(text: string, repos: string[]): string {
  const body = repos.flatMap((r) => [...repoBlock(r), ""]).join("\n").trimEnd();
  const section = `${MARK_BEGIN}\n${body}${body ? "\n" : ""}${MARK_END}`;
  const s = split(text);
  if (s.section !== null) return `${s.before}${section}${s.after}`;
  return `${text.trimEnd()}\n\n${section}\n`;
}

/** The repositories the section should hold, and which of them are new. */
export function plan(text: string, found: string[], prune: boolean): { repos: string[]; added: string[] } {
  const s = split(text);
  const listed = listedRepos(s.section);
  const hand = handManaged(s.before + s.after);
  const keep = prune ? [] : listed;
  const repos = [...new Set([...keep, ...found])].filter((r) => r && !hand.has(r)).sort();
  return { repos, added: repos.filter((r) => !listed.includes(r)) };
}

// ---------------------------------------------------------------- I/O

const HOME = Deno.env.get("HOME") ?? "";
const CONFIG = `${HOME}/.local/state/syncthing/config.xml`;
const SKIP_DIRS = new Set([".git", "node_modules", ".stversions", ".venv", "venv", ".cache"]);

type Folder = { id: string; label: string; path: string; type: string };
function folders(xml: string): Folder[] {
  return [...xml.matchAll(/<folder\b([^>]*)>/g)].map((m) => {
    const at = (k: string) => m[1].match(new RegExp(`\\b${k}="([^"]*)"`))?.[1] ?? "";
    return {
      id: at("id"),
      label: at("label"),
      path: at("path").replace(/^~/, HOME),
      type: at("type") || "sendreceive",
    };
  }).filter((f) => f.path && f.type === "sendreceive");
}

/** Directories holding a `.git` entry (dir, or file for worktrees), without descending into a repository. */
export function findRepos(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    if (dir !== root && entries.some((e) => e.name === ".git")) {
      out.push(dir.slice(root.length + 1));
      return;
    }
    if (depth >= 7) return;
    for (const e of entries) if (e.isDirectory && !SKIP_DIRS.has(e.name)) walk(`${dir}/${e.name}`, depth + 1);
  };
  walk(root, 0);
  return out;
}

async function rescan(xml: string, folder: string) {
  const key = xml.match(/<apikey>([^<]+)<\/apikey>/)?.[1];
  const addr = xml.match(/<gui\b[^>]*>[\s\S]*?<address>([^<]+)<\/address>/)?.[1] ?? "127.0.0.1:8384";
  if (!key) return;
  const url = `http://${addr}/rest/db/scan?folder=${encodeURIComponent(folder)}&sub=.stignore-common`;
  try {
    await fetch(url, { method: "POST", headers: { "X-API-Key": key }, signal: AbortSignal.timeout(5000) });
  } catch { /* Syncthing down: the next scan loads the rules anyway */ }
}

async function notify(body: string) {
  try {
    await new Deno.Command("notify-send", { args: ["-a", "Syncthing", "Syncthing: repository excluded", body] })
      .output();
  } catch { /* no desktop session */ }
}

async function main() {
  const args = Deno.args;
  const APPLY = args.includes("--apply"), QUIET = args.includes("--quiet"), PRUNE = args.includes("--prune");
  const only = args.includes("--folder") ? args[args.indexOf("--folder") + 1] : null;
  const log = (s: string) => {
    if (!QUIET) console.log(s);
  };
  let xml: string;
  try {
    xml = await Deno.readTextFile(CONFIG);
  } catch {
    log(`no Syncthing config at ${CONFIG}`);
    return;
  }

  for (const f of folders(xml)) {
    if (only && ![f.id, f.label, f.path].includes(only)) continue;
    const file = `${f.path}/.stignore-common`;
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    } // folder without shared rules: not ours
    const found = findRepos(f.path);
    if (!found.length && split(text).section === null) continue;
    const { repos, added } = plan(text, found, PRUNE);
    const next = render(text, repos);
    if (next === text) log(`${f.label}: up to date (${repos.length} repositories)`);
    else {
      const dropped = listedRepos(split(text).section).filter((r) => !repos.includes(r));
      log(
        `${f.label}: ${
          added.map((r) => `+ ${r}`).concat(dropped.map((r) => `- ${r}`)).join("  ") || "section rewritten"
        }`,
      );
      if (APPLY) {
        const bak = `${HOME}/.local/state/stignore-gen`;
        await Deno.mkdir(bak, { recursive: true });
        await Deno.writeTextFile(
          `${bak}/${f.id}.${new Date().toISOString().replace(/[:.]/g, "-")}.stignore-common`,
          text,
        );
        await Deno.writeTextFile(file, next);
        if (QUIET) {
          for (const r of added) await notify(`${f.label}/${r}: git carries it, Syncthing only its .env files`);
        }
      }
    }
    if (APPLY) await rescan(xml, f.id);
  }
  if (!APPLY) log("(dry run: --apply writes)");
}

if (import.meta.main) await main();
