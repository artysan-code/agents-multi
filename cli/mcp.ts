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

import { type Check, desktopDir, has, HOME, lstat, type Profile, profileNames, readJson, readText, REPO, run, running, RUNTIME, STATE, stat } from "./lib.ts";

type ServerCfg = Record<string, unknown> & { _profiles?: string[]; _surfaces?: Surface[] };
type Surface = "cli" | "desktop";
export interface Registry { profiles: string[]; servers: Record<string, ServerCfg> }
export interface Target { profile: Profile; surface: Surface; path: string; managedKey: string }
export interface Change { target: Target; name: string; kind: "add" | "update" | "remove" }

const REGISTRY = `${REPO}/shared/mcp/servers.json`;
const STATE_FILE = `${STATE}/mcp-state.json`;
const LEGACY_STATE = `${REPO}/shared/mcp/.sync-state.json`;
const BACKUPS = `${STATE}/mcp-sync-backups`;
const KEEP = 5;

export async function loadRegistry(): Promise<Registry> {
  const r = await readJson<Registry>(REGISTRY);
  if (!r?.servers) throw new Error(`registry MCP assente o non valido: ${REGISTRY}`);
  return { profiles: r.profiles ?? await profileNames(), servers: r.servers };
}
export function wanted(reg: Registry, t: Target): Record<string, Record<string, unknown>> {
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
export async function targets(): Promise<Target[]> {
  const t: Target[] = [];
  for (const p of await profileNames()) {
    t.push({ profile: p, surface: "cli", path: `${RUNTIME}/${p}/.claude.json`, managedKey: `cli:${p}` });
    t.push({ profile: p, surface: "desktop", path: `${await desktopDir(p)}/claude_desktop_config.json`, managedKey: `desktop:${p}` });
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
  for (const t of await targets()) {
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
  for (const p of await profileNames()) {
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
  for (const t of await targets()) {
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
// Nota: obsidian-brain (wiki-claude) parla solo il protocollo Ollama. Qui NON gira Ollama: sulla
// 11434 risponde `llama-embed-shim` (shared/tools/llama-embed-shim, unit llama-embed-shim.service),
// che traduce verso `llama-server` di llama.cpp (unit llama-embed.service, porta 8090, bge-m3 su Vulkan).
async function getJson(url: string, ms = 1500): Promise<unknown | null> {
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), ms);
    // Deno: il permesso --allow-net è per host letterale, quindi localhost e 127.0.0.1 sono due host diversi
    const r = await fetch(url.replace("://localhost", "://127.0.0.1"), { signal: ctrl.signal }); clearTimeout(to);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function embeddingModels(base: string): Promise<string[] | null> {
  const j = await getJson(`${base.replace(/\/$/, "")}/api/tags`) as { models?: { name: string }[] } | null;
  return j ? (j.models ?? []).map((m) => m.name) : null;
}
export const LLAMA_EMBED_URL = "http://127.0.0.1:8090";
export async function llamaServerOk() { const j = await getJson(`${LLAMA_EMBED_URL}/health`) as { status?: string } | null; return j?.status === "ok"; }

/** Sonda live: avvia il server stdio con la sua config, manda `initialize`, aspetta la risposta. Coglie ciò che i
 *  check statici non vedono (moduli nativi con ABI sbagliata, env mancanti, crash a freddo). Costa: spawn reale. */
export async function probe(cmd: string, args: string[], env: Record<string, string>, timeoutMs = 20000): Promise<{ ok: boolean; ms: number; detail: string }> {
  const t0 = Date.now();
  let child: Deno.ChildProcess | null = null;
  try {
    child = new Deno.Command(cmd, { args, env: { ...Deno.env.toObject(), ...env }, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-multi", version: "probe" } } }) + "\n"));
    const reader = child.stdout.getReader(); const dec = new TextDecoder(); let buf = "";
    const errChunks: string[] = []; const errReader = child.stderr.getReader();
    (async () => { try { for (;;) { const { value, done } = await errReader.read(); if (done) break; errChunks.push(dec.decode(value)); } } catch { /* chiuso */ } })();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const race = await Promise.race([reader.read(), new Promise<{ timeout: true }>((r) => setTimeout(() => r({ timeout: true }), Math.max(1, deadline - Date.now())))]);
      if ("timeout" in race) break;
      if (race.done) break;
      buf += dec.decode(race.value);
      if (buf.includes('"result"') && buf.includes("serverInfo")) return { ok: true, ms: Date.now() - t0, detail: (buf.match(/"name":"([^"]+)","version":"([^"]+)"/) ?? []).slice(1).join(" ") };
      if (buf.includes('"error"')) break;
    }
    const err = errChunks.join("").split("\n").filter((l) => /error|Error|mismatch|ENOENT|not found/.test(l)).slice(0, 2).join(" | ");
    return { ok: false, ms: Date.now() - t0, detail: err || (buf ? `risposta inattesa: ${buf.slice(0, 120)}` : "nessuna risposta") };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, detail: (e as Error).message };
  } finally {
    try { child?.kill("SIGTERM"); } catch { /* già morto */ }
  }
}

/** Controlli statici e leggeri per ogni server del registry: binario, file, dipendenze. Con `live` anche la sonda initialize. */
export async function health(opts: { live?: boolean } = {}): Promise<Check[]> {
  const reg = await loadRegistry(); const out: Check[] = [];
  for (const [name, cfg] of Object.entries(reg.servers)) {
    const cmd = String(cfg.command ?? ""); const args = (cfg.args ?? []) as string[]; const env = (cfg.env ?? {}) as Record<string, string>;
    const problems: string[] = [];
    if (env.PATH) for (const dir of env.PATH.split(":").slice(0, 2)) if (!(await stat(dir))) problems.push(`PATH pinnato: dir assente ${dir}`);
    if (cmd.startsWith("/")) { if (!(await stat(cmd))) problems.push(`binario assente: ${cmd}`); }
    else if (cmd && !(await has(cmd))) problems.push(`comando non nel PATH: ${cmd}`);
    for (const a of args) {
      if (a.startsWith("/") && /\.(ts|js|py|lock)$/.test(a) && !(await stat(a))) problems.push(`file assente: ${a}`);
      const lock = a.match(/^--lock=(.+)$/); if (lock && !(await stat(lock[1]))) problems.push(`lock assente: ${lock[1]}`);
    }
    if (env.VAULT_PATH && !(await stat(env.VAULT_PATH))) problems.push(`vault assente: ${env.VAULT_PATH}`);
    // L'embedding a parte: senza, obsidian-brain si avvia lo stesso e perde solo la ricerca semantica.
    // Su una macchina che llama.cpp non ce l'ha proprio (il portatile) è una scelta, non un guasto.
    const embedding: string[] = [];
    if (env.EMBEDDING_PROVIDER === "ollama") {
      const base = env.OLLAMA_BASE_URL ?? "http://localhost:11434";
      const models = await embeddingModels(base);
      if (!models) embedding.push(`endpoint embedding ${base} (llama-embed-shim) non risponde`);
      else if (env.EMBEDDING_MODEL && !models.some((m) => m.startsWith(env.EMBEDDING_MODEL))) embedding.push(`modello ${env.EMBEDDING_MODEL} non servito dallo shim`);
      if (!(await llamaServerOk())) embedding.push(`llama-server ${LLAMA_EMBED_URL} non risponde (unit llama-embed.service)`);
    }
    const llamaInstalled = !!(await stat(`${HOME}/.local/opt/llama-vulkan/bin/llama-server`));
    if (embedding.length && llamaInstalled) problems.push(...embedding);
    const envFile = args.join(" ").match(/\. "?\$HOME\/([^"\s;]+)/); // pattern `. "$HOME/.config/x/.env"`
    if (envFile && !(await stat(`${Deno.env.get("HOME")}/${envFile[1]}`))) problems.push(`env file assente: ~/${envFile[1]}`);
    const surfaces = (cfg._surfaces ?? ["cli"]).join("+"); const profiles = (cfg._profiles ?? reg.profiles).join("+");
    let live = "";
    if (opts.live && !problems.length && cmd) {
      const r = await probe(cmd, args, env);
      if (r.ok) live = ` · initialize ok in ${(r.ms / 1000).toFixed(1)}s${r.detail ? ` (${r.detail})` : ""}`;
      else problems.push(`non risponde a initialize: ${r.detail}`);
    }
    if (problems.length) {
      const fix = problems.some((x) => x.includes("llama-server") || x.includes("embedding")) ? "systemctl --user start llama-embed-shim.service (tira su anche llama-embed.service): senza, wiki-claude non si connette"
        : problems.some((x) => x.startsWith("modello")) ? "controlla SHIM_MODEL in systemd/user/llama-embed-shim.service e il -hf di llama-embed.service"
        : problems.some((x) => x.includes("ABI") || x.includes("NODE_MODULE_VERSION")) ? "modulo nativo compilato per un altro Node: ricompila con il Node del PATH pinnato (prebuild-install in node_modules/better-sqlite3) e rimuovi ~/.cache/obsidian-brain/abi-heal-attempted-*"
        : "sistemare la dipendenza o correggere shared/mcp/servers.json";
      out.push({ id: `mcp.${name}`, status: "fail", msg: `MCP ${name}: ${problems.join("; ")}`, fix });
    }
    else if (embedding.length) {
      out.push({
        id: `mcp.${name}`, status: "warn",
        msg: `MCP ${name} (${profiles} · ${surfaces}) pronto senza ricerca semantica${live}`,
        fix: "macchina senza llama.cpp: ricerca testuale e grafo funzionano, la semantica no. Per averla: installa llama.cpp e abilita llama-embed{,-shim}.service",
      });
    } else out.push({ id: `mcp.${name}`, status: "ok", msg: `MCP ${name} (${profiles} · ${surfaces}) pronto${live}` });
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
