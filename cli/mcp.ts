// mcp.ts — registry MCP unico (shared/mcp/servers.json) applicato a due superfici per profilo:
//   cli      → ~/.claude-multi/<p>/.claude.json            (Claude Code CLI + Claude Code embedded nel Desktop)
//   desktop  → ~/.config/Claude[-Work]/claude_desktop_config.json   (chat di Claude Desktop)
//
// Registry: { "profiles": [...], "servers": { name: { ...config, "_profiles": [...], "_surfaces": ["cli","desktop"] } } }
//   _profiles  default = tutti i profili · _surfaces default = ["cli"]
// Merge non distruttivo: si toccano solo i server gestiti dal registry; quelli aggiunti a mano restano.
// Stato (quali server sono stati gestiti per target) in XDG state: è per-macchina, non nel repo.
// Backup del file prima di ogni scrittura in XDG state (600, ultimi 5): mai nella dir del profilo,
// perché .claude.json contiene oauthAccount e i backup lasciati lì sono già finiti su Syncthing.

import { type Check, DESKTOP_DIR, has, lstat, PROFILES, type Profile, readJson, readText, REPO, run, running, RUNTIME, STATE, stat } from "./lib.ts";

type ServerCfg = Record<string, unknown> & { _profiles?: string[]; _surfaces?: Surface[] };
type Surface = "cli" | "desktop";
interface Registry { profiles: string[]; servers: Record<string, ServerCfg> }
interface Target { profile: Profile; surface: Surface; path: string; managedKey: string }
export interface Change { target: Target; name: string; kind: "add" | "update" | "remove" }

const REGISTRY = `${REPO}/shared/mcp/servers.json`;
const STATE_FILE = `${STATE}/mcp-state.json`;
const LEGACY_STATE = `${REPO}/shared/mcp/.sync-state.json`;
const BACKUPS = `${STATE}/mcp-sync-backups`;
const KEEP = 5;

export async function loadRegistry(): Promise<Registry> {
  const r = await readJson<Registry>(REGISTRY);
  if (!r?.servers) throw new Error(`registry MCP assente o non valido: ${REGISTRY}`);
  return { profiles: r.profiles ?? [...PROFILES], servers: r.servers };
}
function wanted(reg: Registry, t: Target): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const profiles = cfg._profiles ?? reg.profiles;
    const surfaces = cfg._surfaces ?? ["cli"];
    if (!profiles.includes(t.profile) || !surfaces.includes(t.surface)) continue;
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(cfg)) if (!k.startsWith("_")) clean[k] = v;
    if (t.surface === "desktop") delete clean.type; // il Desktop accetta command/args/env; "type" è lessico della CLI
    out[name] = clean;
  }
  return out;
}
export function targets(): Target[] {
  const t: Target[] = [];
  for (const p of PROFILES) {
    t.push({ profile: p, surface: "cli", path: `${RUNTIME}/${p}/.claude.json`, managedKey: `cli:${p}` });
    t.push({ profile: p, surface: "desktop", path: `${DESKTOP_DIR[p]}/claude_desktop_config.json`, managedKey: `desktop:${p}` });
  }
  return t;
}
async function loadState(): Promise<Record<string, string[]>> {
  const s = await readJson<Record<string, string[]>>(STATE_FILE);
  if (s) return s;
  // migrazione dal vecchio file nel repo (chiavi = profilo → superficie cli)
  const legacy = await readJson<Record<string, string[]>>(LEGACY_STATE);
  if (!legacy) return {};
  const out: Record<string, string[]> = {};
  for (const [p, names] of Object.entries(legacy)) out[`cli:${p}`] = names;
  return out;
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Differenze per ogni target esistente (i file assenti vengono saltati: profilo o Desktop non installati). */
export async function plan(): Promise<{ changes: Change[]; skipped: Target[] }> {
  const reg = await loadRegistry(); const state = await loadState();
  const changes: Change[] = []; const skipped: Target[] = [];
  for (const t of targets()) {
    const conf = await readJson<{ mcpServers?: Record<string, unknown> }>(t.path);
    if (!conf) { skipped.push(t); continue; }
    const current = conf.mcpServers ?? {};
    const want = wanted(reg, t);
    for (const [name, cfg] of Object.entries(want)) {
      if (!(name in current)) changes.push({ target: t, name, kind: "add" });
      else if (!eq(current[name], cfg)) changes.push({ target: t, name, kind: "update" });
    }
    for (const name of state[t.managedKey] ?? []) if (!(name in want) && name in current) changes.push({ target: t, name, kind: "remove" });
  }
  return { changes, skipped };
}

async function backup(t: Target) {
  await Deno.mkdir(BACKUPS, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  const dest = `${BACKUPS}/${t.managedKey.replace(":", "-")}.${stamp}.json`;
  await Deno.copyFile(t.path, dest); await Deno.chmod(dest, 0o600);
  const old = (await Array.fromAsync(Deno.readDir(BACKUPS))).map((e) => e.name).filter((n) => n.startsWith(`${t.managedKey.replace(":", "-")}.`)).sort().slice(0, -KEEP);
  for (const n of old) await Deno.remove(`${BACKUPS}/${n}`);
}

/** Chi potrebbe riscrivere il file sotto i piedi: sessioni CLI/embedded del profilo (cli) o l'istanza Desktop (desktop). */
export async function blockers(): Promise<Record<string, string[]>> {
  const r = await running(); const out: Record<string, string[]> = {};
  for (const p of PROFILES) {
    const cli = r.cli.filter((c) => c.profile === p).map((c) => `pid ${c.pid}${c.embedded ? " (desktop)" : ""}`);
    const desk = r.desktop.filter((d) => d.variant === p).map((d) => `pid ${d.pid}`);
    if (cli.length) out[`cli:${p}`] = cli;
    if (desk.length) out[`desktop:${p}`] = desk;
  }
  return out;
}

export async function apply(opts: { force?: boolean } = {}) {
  const reg = await loadRegistry(); const state = await loadState();
  const { changes } = await plan();
  const block = opts.force ? {} : await blockers();
  const touched = new Set(changes.map((c) => c.target.managedKey));
  const blocked = [...touched].filter((k) => block[k]);
  if (blocked.length) {
    const msg = blocked.map((k) => `${k} (${block[k].join(", ")})`).join("; ");
    throw new Error(`istanze attive che riscriverebbero la config: ${msg}. Chiudile e rilancia, o --force.`);
  }
  for (const t of targets()) {
    const mine = changes.filter((c) => c.target.managedKey === t.managedKey);
    const conf = await readJson<Record<string, unknown> & { mcpServers?: Record<string, unknown> }>(t.path);
    if (!conf) continue;
    const want = wanted(reg, t);
    if (mine.length) {
      const merged: Record<string, unknown> = { ...(conf.mcpServers ?? {}) };
      for (const c of mine) if (c.kind === "remove") delete merged[c.name];
      Object.assign(merged, want);
      conf.mcpServers = merged;
      await backup(t);
      const tmp = `${t.path}.claude-multi.tmp`;
      await Deno.writeTextFile(tmp, JSON.stringify(conf, null, 2) + "\n");
      await Deno.rename(tmp, t.path);
    }
    state[t.managedKey] = Object.keys(want).sort();
  }
  await Deno.mkdir(STATE, { recursive: true });
  await Deno.writeTextFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  return changes;
}

// ---------------------------------------------------------------- health
async function ollamaModels(base: string): Promise<string[] | null> {
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`${base.replace(/\/$/, "")}/api/tags`, { signal: ctrl.signal }); clearTimeout(to);
    if (!r.ok) return null;
    const j = await r.json() as { models?: { name: string }[] };
    return (j.models ?? []).map((m) => m.name);
  } catch { return null; }
}
/** Controlli statici e leggeri per ogni server del registry: binario, file, dipendenze (Ollama). */
export async function health(): Promise<Check[]> {
  const reg = await loadRegistry(); const out: Check[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const cmd = String(cfg.command ?? ""); const args = (cfg.args ?? []) as string[]; const env = (cfg.env ?? {}) as Record<string, string>;
    const problems: string[] = [];
    if (cmd.startsWith("/")) { if (!(await stat(cmd))) problems.push(`binario assente: ${cmd}`); }
    else if (cmd && !(await has(cmd))) problems.push(`comando non nel PATH: ${cmd}`);
    for (const a of args) {
      if (a.startsWith("/") && /\.(ts|js|py|lock)$/.test(a) && !(await stat(a))) problems.push(`file assente: ${a}`);
      const lock = a.match(/^--lock=(.+)$/); if (lock && !(await stat(lock[1]))) problems.push(`lock assente: ${lock[1]}`);
    }
    if (env.VAULT_PATH && !(await stat(env.VAULT_PATH))) problems.push(`vault assente: ${env.VAULT_PATH}`);
    if (env.EMBEDDING_PROVIDER === "ollama") {
      const models = await ollamaModels(env.OLLAMA_BASE_URL ?? "http://localhost:11434");
      if (!models) problems.push("Ollama non risponde");
      else if (env.EMBEDDING_MODEL && !models.some((m) => m.startsWith(env.EMBEDDING_MODEL))) problems.push(`modello ${env.EMBEDDING_MODEL} non in Ollama`);
    }
    const envFile = args.join(" ").match(/\. "?\$HOME\/([^"\s;]+)/); // pattern `. "$HOME/.config/x/.env"`
    if (envFile && !(await stat(`${Deno.env.get("HOME")}/${envFile[1]}`))) problems.push(`env file assente: ~/${envFile[1]}`);
    const surfaces = (cfg._surfaces ?? ["cli"]).join("+"); const profiles = (cfg._profiles ?? reg.profiles).join("+");
    if (problems.length) {
      const fix = problems.some((x) => x.startsWith("Ollama")) ? "avvia Ollama (systemctl start ollama, o `ollama serve`): senza, wiki-claude non si connette"
        : problems.some((x) => x.startsWith("modello")) ? `ollama pull ${env.EMBEDDING_MODEL}`
        : "sistemare la dipendenza o correggere shared/mcp/servers.json";
      out.push({ id: `mcp.${name}`, status: "fail", msg: `MCP ${name}: ${problems.join("; ")}`, fix });
    }
    else out.push({ id: `mcp.${name}`, status: "ok", msg: `MCP ${name} (${profiles} · ${surfaces}) pronto` });
  }
  return out;
}

export function describe(c: Change) {
  const sym = { add: "+", update: "~", remove: "−" }[c.kind];
  return `${c.target.managedKey.padEnd(16)} ${sym} ${c.name}`;
}
export async function legacyStatePresent() { return !!(await lstat(LEGACY_STATE)); }
export async function readTargetRaw(t: Target) { return await readText(t.path); }
export { run };
