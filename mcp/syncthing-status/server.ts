#!/usr/bin/env -S deno run --allow-net=127.0.0.1:8384 --allow-read --allow-env --allow-run=git
// syncthing-status — MCP server (read-only) sullo stato di Syncthing locale.
// Archetipo 3 (CLI & MCP). Scritto a mano; parla SOLO con la REST localhost di Syncthing.
// API key letta a runtime dal config.xml (o env STGUI_APIKEY): non viene mai persistita altrove.
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";

const BASE = Deno.env.get("ST_URL") ?? "http://127.0.0.1:8384";
const HOME = Deno.env.get("HOME") ?? "";

function configPath(): string {
  const env = Deno.env.get("ST_CONFIG");
  if (env) return env;
  for (const p of [`${HOME}/.local/state/syncthing/config.xml`, `${HOME}/.config/syncthing/config.xml`]) {
    try { Deno.statSync(p); return p; } catch { /* next */ }
  }
  return `${HOME}/.local/state/syncthing/config.xml`;
}

function apiKey(): string {
  const env = Deno.env.get("STGUI_APIKEY");
  if (env) return env;
  const xml = Deno.readTextFileSync(configPath());
  const m = xml.match(/<apikey>([^<]+)<\/apikey>/);
  if (!m) throw new Error("API key Syncthing non trovata (config.xml o env STGUI_APIKEY).");
  return m[1].trim();
}

const KEY = apiKey();

async function st(path: string): Promise<any> {
  const r = await fetch(`${BASE}${path}`, { headers: { "X-API-Key": KEY } });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return await r.json();
}
const txt = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

async function* walk(root: string, pick: (e: Deno.DirEntry) => boolean, prune: (n: string) => boolean, max = 8, d = 0): AsyncGenerator<string> {
  if (d > max) return;
  let entries: Deno.DirEntry[];
  try { entries = [...Deno.readDirSync(root)]; } catch { return; }
  for (const e of entries) {
    const p = `${root}/${e.name}`;
    if (pick(e)) yield p;
    else if (e.isDirectory && !prune(e.name)) yield* walk(p, pick, prune, max, d + 1);
  }
}

// Compila un pattern .stignore in regex con la semantica Syncthing:
//  '*' NON attraversa '/', '**' sì, '?' = un char non-'/'; pattern rooted ('/x') o con '/'
//  ancorato alla radice, altrimenti matcha il basename a qualunque livello; flag (?d)/(?i) e
//  negazione '!' gestiti. Il trailing (/|$) fa sì che un pattern-dir matchi anche i discendenti.
type Compiled = { re: RegExp; negate: boolean };
function compilePattern(raw: string): Compiled | null {
  const stripFlags = (x: string) => x.replace(/^(\(\?[a-z]\))+/i, "");
  let s = raw.trim();
  if (!s || s.startsWith("//") || s.startsWith("#")) return null;
  s = stripFlags(s);
  let negate = false;
  if (s.startsWith("!")) { negate = true; s = s.slice(1); }
  s = stripFlags(s);
  if (!s) return null;
  const rooted = s.startsWith("/");
  if (rooted) s = s.replace(/^\/+/, "");
  const anchored = rooted || s.includes("/");
  let rx = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "*") { if (s[i + 1] === "*") { rx += ".*"; i++; } else rx += "[^/]*"; }
    else if (c === "?") rx += "[^/]";
    else rx += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { re: new RegExp((anchored ? "^" : "(^|.*/)") + rx + "(/|$)"), negate };
}
// first-match-wins: il primo pattern che matcha decide (negato '!' => NON ignorato).
function isIgnored(rel: string, compiled: Compiled[]): boolean {
  for (const c of compiled) if (c.re.test(rel)) return !c.negate;
  return false;
}

const server = new McpServer({ name: "syncthing-status", version: "0.1.0" });

server.registerTool("syncthing_status", {
  description: "Stato generale di Syncthing locale: versione, device, uptime, n. folder/device, connessioni attive, errori di sistema.",
  inputSchema: {},
}, async () => {
  const [ver, sys, cfg, conns, errs] = await Promise.all([
    st("/rest/system/version"), st("/rest/system/status"), st("/rest/config"),
    st("/rest/system/connections"), st("/rest/system/error"),
  ]);
  const connected = Object.values(conns.connections ?? {}).filter((c: any) => c.connected).length;
  return txt({
    version: ver.version, os: `${ver.os}/${ver.arch}`,
    myID: String(sys.myID ?? "").slice(0, 7),
    uptime_h: Math.round((sys.uptime ?? 0) / 360) / 10,
    folders: (cfg.folders ?? []).length,
    devices_total: (cfg.devices ?? []).length,
    devices_connected: connected,
    system_errors: (errs.errors ?? []).map((e: any) => e.message ?? e),
  });
});

server.registerTool("syncthing_folders", {
  description: "Stato per-folder: label, path, tipo (sendreceive/receiveencrypted), stato, file da sincronizzare, errori.",
  inputSchema: {},
}, async () => {
  const cfg = await st("/rest/config");
  const rows = [];
  for (const f of cfg.folders ?? []) {
    let s: any = {};
    try { s = await st(`/rest/db/status?folder=${encodeURIComponent(f.id)}`); } catch { /* */ }
    rows.push({
      label: f.label || f.id, id: f.id, path: f.path, type: f.type, paused: !!f.paused,
      state: s.state ?? "?", needFiles: s.needFiles ?? 0, needDeletes: s.needDeletes ?? 0,
      pullErrors: s.pullErrors ?? s.errors ?? 0, globalFiles: s.globalFiles ?? 0,
    });
  }
  return txt(rows);
});

server.registerTool("syncthing_conflicts", {
  description: "Cerca file di conflitto Syncthing (*.sync-conflict-*) nelle cartelle sincronizzate. Vanno risolti/rimossi.",
  inputSchema: {},
}, async () => {
  const cfg = await st("/rest/config");
  const found: string[] = [];
  for (const f of cfg.folders ?? []) {
    for await (const e of walk(f.path, (e) => e.isFile && e.name.includes(".sync-conflict-"), (n) => n === "node_modules" || n === ".stversions")) found.push(e);
  }
  return txt(found.length ? { count: found.length, files: found } : "Nessun file *.sync-conflict-* trovato. ✓");
});

// Enumera i file tracciati da git (read-only). Vuoto se non-repo o errore.
async function gitTracked(repoAbs: string): Promise<string[]> {
  try {
    const cmd = new Deno.Command("git", { args: ["-C", repoAbs, "ls-files", "-z"], stdout: "piped", stderr: "null" });
    const { code, stdout } = await cmd.output();
    if (code !== 0) return [];
    return new TextDecoder().decode(stdout).split("\0").filter(Boolean);
  } catch { return []; }
}

server.registerTool("syncthing_git_guard", {
  description: "REGOLA CRITICA (v2): per ogni repo git dentro un folder 'sendreceive' verifica cosa Syncthing sincronizza DAVVERO. Domanda giusta: '.git e i file tracciati vengono sincronizzati?' (non 'la cartella-repo è esclusa?'). .git sincronizzato => corruzione del repo (CRITICAL). File tracciati sincronizzati => drift del working-tree (WARN). Solo gitignorato-prezioso sincronizzato => partizione corretta (OK).",
  inputSchema: {},
}, async () => {
  const cfg = await st("/rest/config");
  const report: any[] = [];
  const CAP = 5000; // tetto di file tracciati ispezionati per repo
  for (const f of cfg.folders ?? []) {
    if (f.type !== "sendreceive") continue;
    let pats: string[] = [];
    try { pats = (await st(`/rest/db/ignores?folder=${encodeURIComponent(f.id)}`)).ignore ?? []; } catch { /* */ }
    const compiled = pats.map(compilePattern).filter((c): c is Compiled => c !== null);
    for await (const g of walk(f.path, (e) => e.isDirectory && e.name === ".git", (n) => n === "node_modules" || n === ".git" || n === ".stversions")) {
      const repoAbs = g.replace(/\/?\.git$/, "");
      const base = repoAbs.slice(f.path.length).replace(/^\/+/, "");
      const join = (sub: string) => (base ? `${base}/${sub}` : sub);
      const gitDirSynced = !isIgnored(join(".git"), compiled);
      // se .git è già esposto è già CRITICAL: niente enumerazione tracciati
      const tracked = gitDirSynced ? [] : await gitTracked(repoAbs);
      const sample = tracked.slice(0, CAP);
      let exposed = 0;
      for (const t of sample) if (!isIgnored(join(t), compiled)) exposed++;
      const truncated = tracked.length > CAP;
      const risk = gitDirSynced
        ? "🔴 CRITICAL — .git sincronizzato (rischio corruzione repo)"
        : exposed > 0
          ? `🟡 WARN — ${exposed}${truncated ? "+" : ""}/${tracked.length} file tracciati sincronizzati (drift working-tree)`
          : "🟢 OK — partizione corretta (solo gitignorato-prezioso sincronizzato)";
      report.push({
        folder: f.label || f.id, repo: base || "(root)",
        gitDirSynced, trackedExposed: exposed, trackedTotal: tracked.length,
        ...(truncated ? { note: `ispezionati i primi ${CAP} file tracciati` } : {}),
        risk,
      });
    }
  }
  const critical = report.filter((r) => r.gitDirSynced).length;
  const warn = report.filter((r) => !r.gitDirSynced && r.trackedExposed > 0).length;
  return txt({
    checked: report.length, critical, warn, ok: report.length - critical - warn,
    repos: report.length ? report : "Nessuna repo git dentro folder sendreceive.",
  });
});

await server.connect(new StdioServerTransport());
