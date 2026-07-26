#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env
// stignore-gen — genera la sezione gestita di .stignore dai .gitignore dei repo.
// MODE B (massimalista): sincronizza TUTTO il gitignorato TRANNE derivato/spazzatura.
// Partizione: git possiede i file tracciati; Syncthing sincronizza il gitignorato-prezioso;
// .git + tracciato + derivato => ignorati da Syncthing (zero rischio corruzione).
//
// INVARIANTE DI SICUREZZA: re-include solo path che git IGNORA (dal .gitignore, denylist a parte);
// salta le righe '!' del .gitignore (sono file TRACCIATI) => non sincronizza mai file tracciati.
//
// Dry-run di default. --apply scrive (con backup). --folder <path> limita a una folder.
// Legge i folder da config.xml (niente API key: servono solo i path).
const ARGS = Deno.args;
const APPLY = ARGS.includes("--apply");
const onlyFolder = ARGS.includes("--folder") ? ARGS[ARGS.indexOf("--folder") + 1] : null;
const HOME = Deno.env.get("HOME") ?? "";
const STAMP = Deno.args.includes("--stamp") ? ARGS[ARGS.indexOf("--stamp") + 1] : "manual-run";
const MARK_A = "# >>> stignore-gen (auto) >>>";
const MARK_B = "# <<< stignore-gen (auto) <<<";

// derivato/spazzatura: gitignorato ma NON da sincronizzare (rigenerabile / per-macchina / junk)
const DENY_NAMES = new Set([
  "node_modules", ".pnpm-store", "bower_components", "vendor", ".venv", "venv", "env",
  "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", "target", ".gradle",
  "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".turbo", ".wrangler",
  ".cache", ".parcel-cache", "coverage", ".nyc_output", ".trash", ".stversions",
]);
const DENY_GLOBS = [
  /^\*\.log$/, /^\*\.tmp$/, /^\*\.temp$/, /^\*\.bak$/, /^\*~$/, /^\*\.sw[op]$/, /^\*\.tsbuildinfo$/,
  /\.DS_Store$/, /^Thumbs\.db$/,
  /^\*\.pyc$/, /^\*\.pyo$/, /^\*\.class$/, /^\*\.o$/, /^\*\.so$/, /^\*\.a$/, /^\*\.egg-info$/, // compilati/derivati
];
const isDenied = (core: string) => DENY_NAMES.has(core) || DENY_GLOBS.some((r) => r.test(core));

function folders(): { label: string; path: string }[] {
  const xml = Deno.readTextFileSync(`${HOME}/.local/state/syncthing/config.xml`);
  return [...xml.matchAll(/<folder\b([^>]*)>/g)].map((m) => {
    const a = m[1];
    return {
      path: a.match(/\bpath="([^"]*)"/)?.[1] ?? "",
      label: a.match(/\blabel="([^"]*)"/)?.[1] ?? "",
      type: a.match(/\btype="([^"]*)"/)?.[1] ?? "sendreceive",
    };
  }).filter((f) => f.path && f.type === "sendreceive");
}

function findRepos(root: string): string[] {
  const repos: string[] = [];
  const rec = (dir: string, depth: number) => {
    if (depth > 7) return;
    let entries: Deno.DirEntry[];
    try { entries = [...Deno.readDirSync(dir)]; } catch { return; }
    let hasGit = false;
    for (const e of entries) if (e.name === ".git") hasGit = true;
    if (hasGit) repos.push(dir);
    for (const e of entries) {
      if (!e.isDirectory) continue;
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".stversions") continue;
      rec(`${dir}/${e.name}`, depth + 1);
    }
  };
  rec(root, 0);
  return repos;
}

function preciousIncludes(R: string, gitignore: string): string[] {
  const out: string[] = [];
  for (const raw of gitignore.split("\n")) {
    let line = raw.replace(/(^|[^\\])#.*$/, "$1").trim(); // toglie commenti non-escaped
    if (!line || line.startsWith("!")) continue;          // '!' = tracciato => salta (mai syncare tracciati)
    const rooted = line.startsWith("/");
    const isDir = line.endsWith("/");
    const core = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!core || isDenied(core)) continue;                // derivato/spazzatura => resta ignorato
    const base = rooted ? `/${R}/${core}` : `/${R}/**/${core}`;
    out.push(`!${base}`, `!${base}/**`);                  // file: il /** non matcha nulla (innocuo); dir: include il contenuto
  }
  return out;
}

function genSection(folderPath: string): string {
  const repos = findRepos(folderPath)
    .map((d) => d.slice(folderPath.length).replace(/^\/+/, ""))
    .filter((r) => r) // niente repo alla radice della folder (gestione a mano)
    .sort((a, b) => b.split("/").length - a.split("/").length); // PIÙ PROFONDI PRIMA (nesting: il figlio vince sul catch-all del padre)
  const lines: string[] = [];
  for (const R of repos) {
    let gi = "";
    try { gi = Deno.readTextFileSync(`${folderPath}/${R}/.gitignore`); } catch { /* nessun .gitignore */ }
    const inc = gi ? preciousIncludes(R, gi) : [];
    lines.push(`// repo: ${R}${inc.length ? "" : "  (nessun gitignorato-prezioso: solo esclusione tracciato+.git)"}`);
    lines.push(...inc);
    lines.push(`/${R}/**`); // ignora tutto il resto del repo (tracciato + .git + derivato)
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function rebuild(existing: string, section: string): string {
  // preserva tutto FUORI dai marker; rigenera solo la sezione gestita
  let manual = existing;
  const a = existing.indexOf(MARK_A), b = existing.indexOf(MARK_B);
  if (a >= 0 && b > a) manual = (existing.slice(0, a) + existing.slice(b + MARK_B.length)).trimEnd();
  manual = manual.trimEnd();
  return `${manual}\n\n${MARK_A}\n// Generato da stignore-gen (mode B) — ${STAMP}. NON editare a mano questa sezione.\n${section}\n${MARK_B}\n`;
}

// ---- run ----
let targets = folders();
if (onlyFolder) targets = targets.filter((f) => f.path === onlyFolder || f.label === onlyFolder);
for (const f of targets) {
  const stPath = `${f.path}/.stignore`;
  let existing = "";
  try { existing = Deno.readTextFileSync(stPath); } catch { /* nuovo */ }
  const section = genSection(f.path);
  const next = rebuild(existing, section);
  console.log(`\n${"=".repeat(60)}\nFOLDER: ${f.label}  (${f.path})`);
  if (next === (existing.endsWith("\n") ? existing : existing + (existing ? "\n" : ""))) {
    console.log("(nessuna modifica)");
  }
  if (APPLY) {
    if (existing) Deno.writeTextFileSync(`${stPath}.bak.${Date.now()}`, existing);
    Deno.writeTextFileSync(stPath, next);
    console.log(`✔ scritto ${stPath}${existing ? " (backup .bak.*)" : ""}`);
  } else {
    console.log("--- .stignore risultante (DRY-RUN, non scritto) ---");
    console.log(next);
  }
}
console.log(APPLY ? "\n=== APPLY completato ===" : "\n=== DRY-RUN (usa --apply per scrivere) ===");
