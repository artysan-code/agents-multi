#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * llama-embed-shim — espone l'API embeddings di Ollama davanti a un llama-server.
 *
 * Perché esiste: obsidian-brain (MCP `wiki-claude`) supporta due soli provider di
 * embedding, 'transformers' (ONNX su CPU) e 'ollama'. Non ha un provider OpenAI
 * generico, quindi non può parlare direttamente col /v1/embeddings di llama.cpp.
 * Questo shim traduce le 4 chiamate che obsidian-brain fa davvero:
 *
 *   GET  /api/tags        -> elenco modelli (serve solo per il digest)
 *   POST /api/show        -> capabilities + model_info (dim e context_length)
 *   POST /api/embeddings  -> {model,prompt,options} -> {embedding:[...]}
 *   POST /api/pull        -> no-op: il modello lo serve llama-server, non si scarica qui
 *
 * Ascolta di default sulla porta 11434 (quella di Ollama) proprio per NON dover
 * toccare la config MCP: `OLLAMA_BASE_URL=http://localhost:11434` resta valida.
 *
 * Env: LLAMA_BASE_URL (default http://127.0.0.1:8090)
 *      SHIM_PORT       (default 11434)
 *      SHIM_MODEL      (default bge-m3)
 */
const LLAMA = Deno.env.get("LLAMA_BASE_URL") ?? "http://127.0.0.1:8090";
const PORT = Number(Deno.env.get("SHIM_PORT") ?? "11434");
const MODEL = Deno.env.get("SHIM_MODEL") ?? "bge-m3";
// Generazione: server SEPARATO, acceso solo quando serve (lo usa il distiller).
const GEN = Deno.env.get("GEN_BASE_URL") ?? "http://127.0.0.1:8080";
// GEN_UNIT set but empty = no generation on this machine (a laptop with no room for the model).
const GEN_UNIT = Deno.env.get("GEN_UNIT") ?? "llama-generate.service";
const GEN_IDLE_SEC = Number(Deno.env.get("GEN_IDLE_SEC") ?? "300");

type Meta = { dim: number; ctx: number; digest: string };
let meta: Meta | null = null;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Ricava dim e context reali interrogando llama-server. Una volta sola, poi in cache.
 *  La dim si misura embeddando una stringa: è l'unico modo che non dipende dal
 *  formato interno di /props, che cambia fra versioni di llama.cpp. */
async function getMeta(): Promise<Meta> {
  if (meta) return meta;
  const emb = await embed("probe");
  let ctx = 8192;
  let modelPath = MODEL;
  try {
    const p = await (await fetch(`${LLAMA}/props`)).json();
    ctx = p?.default_generation_settings?.n_ctx ?? ctx;
    modelPath = p?.model_path ?? modelPath;
  } catch { /* best-effort: i default bastano */ }
  meta = { dim: emb.length, ctx, digest: "sha256:" + await sha256Hex(`${modelPath}:${emb.length}`) };
  console.error(`[shim] pronto — modello=${MODEL} dim=${meta.dim} ctx=${meta.ctx} backend=${LLAMA}`);
  return meta;
}

/* ── Ciclo di vita del server di generazione ────────────────────────────────
   Il modello di generazione (8B) pesa GB di VRAM, e la GPU è anche il display.
   Quindi NON sta acceso: lo accendiamo alla prima /api/generate e lo spegniamo
   dopo GEN_IDLE_SEC senza richieste. Il distiller non se ne accorge: continua a
   parlare con la stessa porta 11434 di sempre.                                */
let idleTimer: ReturnType<typeof setTimeout> | undefined;

async function sysctl(...args: string[]): Promise<void> {
  const c = new Deno.Command("systemctl", { args: ["--user", ...args] });
  await c.output();
}

function armIdleStop(): void {
  if (idleTimer !== undefined) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    console.error(`[shim] ${GEN_IDLE_SEC}s di inattività: spengo ${GEN_UNIT}`);
    await sysctl("stop", GEN_UNIT);
    idleTimer = undefined;
  }, GEN_IDLE_SEC * 1000);
}

async function genUp(): Promise<boolean> {
  try {
    const r = await fetch(`${GEN}/health`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

/** Accende il server di generazione e attende che risponda. Il primo avvio può
 *  richiedere minuti se il modello non è ancora in cache. */
async function ensureGen(): Promise<void> {
  if (await genUp()) return;
  console.error(`[shim] accendo ${GEN_UNIT} (on-demand)`);
  await sysctl("start", GEN_UNIT);
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await genUp()) { console.error("[shim] server di generazione pronto"); return; }
  }
  throw new Error(`${GEN_UNIT} non è diventato pronto entro 6 minuti`);
}

async function embed(text: string): Promise<number[]> {
  const r = await fetch(`${LLAMA}/v1/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: text }),
  });
  if (!r.ok) throw new Error(`llama-server HTTP ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  const v = j?.data?.[0]?.embedding;
  if (!Array.isArray(v) || v.length === 0) throw new Error("llama-server ha restituito un vettore vuoto");
  return v;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function handler(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  try {
    if (pathname === "/api/tags") {
      const m = await getMeta();
      return json({ models: [{ name: `${MODEL}:latest`, model: `${MODEL}:latest`, digest: m.digest }] });
    }
    if (pathname === "/api/show") {
      const m = await getMeta();
      // Le chiavi sono suffix-matched da obsidian-brain (`.embedding_length /
      // `.context_length`): il prefisso di architettura è libero.
      return json({
        capabilities: ["embedding"],
        details: { family: "bert" },   // famiglia nominale: conta solo il suffisso delle chiavi sotto
        model_info: { "bert.embedding_length": m.dim, "bert.context_length": m.ctx },
      });
    }
    if (pathname === "/api/embeddings") {
      const b = await req.json();
      const text = typeof b?.prompt === "string" ? b.prompt : "";
      return json({ embedding: await embed(text) });
    }
    if (pathname === "/api/generate") {
      if (!GEN_UNIT) return json({ error: "generation is off on this machine (GEN_UNIT is empty)" }, 503);
      const b = await req.json();
      await ensureGen();
      armIdleStop();
      // Ollama /api/generate -> /v1/chat/completions di llama-server.
      // Passiamo da chat/completions e NON da /completion perche' cosi' llama-server
      // applica il template instruct del modello: il prompt del distiller e' una
      // istruzione, senza template la risposta degenera (verificato: vuota o fuori tema).
      const r = await fetch(`${GEN}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: b?.prompt ?? "" }],
          temperature: b?.options?.temperature ?? 0.2,
          max_tokens: b?.options?.num_predict ?? 4096,
          stream: false,
        }),
      });
      if (!r.ok) throw new Error(`llama-server chat HTTP ${r.status}: ${await r.text().catch(() => "")}`);
      const j = await r.json();
      const out = j?.choices?.[0]?.message?.content ?? "";
      armIdleStop();
      return json({ model: b?.model ?? MODEL, response: out.trim(), done: true });
    }
    if (pathname === "/api/pull") {
      // Non scarichiamo nulla: il modello è già servito da llama-server.
      return new Response(JSON.stringify({ status: "success" }) + "\n", {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    }
    // /health: stesso endpoint di llama-server, così `llm status` può sondare
    // tutte le porte allo stesso modo. Riporta ok solo se il backend risponde.
    if (pathname === "/health") { await getMeta(); return json({ status: "ok" }); }
    if (pathname === "/" || pathname === "/api/version") return json({ version: "llama-embed-shim" });
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(`[shim] ${pathname}: ${e instanceof Error ? e.message : e}`);
    return json({ error: String(e instanceof Error ? e.message : e) }, 502);
  }
}

console.error(`[shim] in ascolto su 127.0.0.1:${PORT} -> ${LLAMA}`);
Deno.serve({ hostname: "127.0.0.1", port: PORT }, handler);
