#!/usr/bin/env -S deno run --allow-net=ark.example.com --allow-read --allow-env
// coolify-ark — MCP server sul Coolify di ark (https://ark.example.com).
//
// Nato dopo aver pilotato Coolify a mano via curl per un deploy intero: i tool
// qui sotto sono le chiamate che sono servite davvero, non quelle che l'API
// espone. Le altre si aggiungono quando servono.
//
// **Non espone nessuna cancellazione, ed è una scelta.** Un `DELETE` via API
// costa un tool call, e la risposta della creazione di un database mi ha già
// restituito una password in chiaro senza che la chiedessi. Distruggere risorse
// e leggere segreti restano gesti da fare a mano, guardando cosa si sta facendo.
//
// Token letto a runtime da ~/.config/secrets/coolify-ark.token (per-macchina,
// mai sincronizzato): non viene persistito altrove né passato in configurazione.
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";
import { z } from "npm:zod@^3.23";

const BASE = Deno.env.get("COOLIFY_URL") ?? "https://ark.example.com";
const HOME = Deno.env.get("HOME") ?? "";

function token(): string {
  const env = Deno.env.get("COOLIFY_TOKEN");
  if (env) return env.trim();
  const p = Deno.env.get("COOLIFY_TOKEN_FILE") ?? `${HOME}/.config/secrets/coolify-ark.token`;
  try {
    return Deno.readTextFileSync(p).trim();
  } catch {
    throw new Error(`token Coolify non trovato in ${p} (o env COOLIFY_TOKEN)`);
  }
}
const KEY = token();

async function api(path: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const testo = await r.text();
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${testo.slice(0, 400)}`);
  try {
    return JSON.parse(testo);
  } catch {
    return testo;
  }
}

const txt = (o: unknown) => ({
  content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }],
});

/**
 * Nomi che quasi certamente contengono un segreto. Il mascheramento è per
 * difetto e non su richiesta: un valore riservato che passa di qui finisce nel
 * contesto e da lì non si toglie più.
 */
const CHIAVE_SEGRETA = /password|secret|token|apikey|api_key|_key$|^key$|private/i;
/** Un URL che si porta dentro le credenziali: `postgres://utente:password@host/db`. */
const CREDENZIALI_NELL_URL = /:\/\/[^/@\s]+:[^/@\s]+@/;

function maschera(chiave: string, valore: unknown): unknown {
  if (typeof valore !== "string" || valore.length === 0) return valore;
  if (CHIAVE_SEGRETA.test(chiave)) return "‹riservato — guardalo dal pannello›";
  // Il nome da solo non basta in nessuna delle due direzioni: `DATABASE_URL`
  // nasconde una password e `FIVETOOLS_URL` è un indirizzo pubblico. Di un URL
  // con credenziali si copre la coppia utente/password e si lascia il resto,
  // che è quello che serve davvero sapere.
  if (CREDENZIALI_NELL_URL.test(valore)) return valore.replace(CREDENZIALI_NELL_URL, "://‹utente›:‹password›@");
  return valore;
}

// deno-lint-ignore no-explicit-any -- le risposte di Coolify non hanno uno schema pubblicato
type Qualunque = any;

/** Risolve un'applicazione da uuid o da nome, perché a memoria si tiene il nome. */
async function trovaApp(rif: string): Promise<Qualunque> {
  const apps = await api("/applications") as Qualunque[];
  const per = apps.find((a) => a.uuid === rif) ??
    apps.find((a) => String(a.name ?? "").toLowerCase() === rif.toLowerCase()) ??
    apps.find((a) => String(a.name ?? "").toLowerCase().includes(rif.toLowerCase()));
  if (!per) {
    const nomi = apps.map((a) => `${a.name} (${a.uuid})`).join(", ");
    throw new Error(`nessuna applicazione per "${rif}". Ci sono: ${nomi}`);
  }
  return per;
}

const server = new McpServer({ name: "coolify-ark", version: "0.1.0" });

server.registerTool("coolify_risorse", {
  description:
    "Panoramica di cosa gira su Coolify: server, progetti, applicazioni (con dominio e stato) e database gestiti. Il primo tool da chiamare quando non si sa cosa c'è.",
  inputSchema: {},
}, async () => {
  const [servers, progetti, apps, db] = await Promise.all([
    api("/servers"),
    api("/projects"),
    api("/applications"),
    api("/databases"),
  ]) as Qualunque[][];
  return txt({
    server: servers.map((s) => ({ uuid: s.uuid, nome: s.name, raggiungibile: s.is_reachable })),
    progetti: progetti.map((p) => ({ uuid: p.uuid, nome: p.name })),
    applicazioni: apps.map((a) => ({
      uuid: a.uuid,
      nome: a.name,
      dominio: a.fqdn ?? null,
      stato: a.status,
      ramo: a.git_branch,
      tipo: a.build_pack,
    })),
    database: db.map((d) => ({ uuid: d.uuid, nome: d.name, stato: d.status })),
  });
});

server.registerTool("coolify_applicazione", {
  description:
    "Dettaglio di un'applicazione: sorgente git, compose, domini, stato, salute. Accetta uuid o nome. I valori riservati sono mascherati.",
  inputSchema: { applicazione: z.string().describe("uuid o nome dell'applicazione") },
}, async ({ applicazione }: { applicazione: string }) => {
  const a = await trovaApp(applicazione);
  return txt({
    uuid: a.uuid,
    nome: a.name,
    stato: a.status,
    dominio: a.fqdn,
    domini_compose: a.docker_compose_domains,
    git: { repository: a.git_repository, ramo: a.git_branch, compose: a.docker_compose_location },
    tipo: a.build_pack,
    porte_esposte: a.ports_exposes,
    // I secret dei webhook esistono sempre: dire che ci sono basta, mostrarli no.
    webhook_configurati: Object.keys(a).filter((k) => k.startsWith("manual_webhook_secret_") && a[k]),
  });
});

server.registerTool("coolify_variabili", {
  description:
    "Variabili d'ambiente di un'applicazione. Elenca i nomi; i valori che sembrano riservati sono mascherati.",
  inputSchema: { applicazione: z.string().describe("uuid o nome dell'applicazione") },
}, async ({ applicazione }: { applicazione: string }) => {
  const a = await trovaApp(applicazione);
  const envs = await api(`/applications/${a.uuid}/envs`) as Qualunque[];
  return txt(envs
    .filter((e) => !e.is_preview) // le copie di anteprima le crea Coolify da sé: rumore
    .map((e) => ({ chiave: e.key, valore: maschera(e.key, e.value) })));
});

server.registerTool("coolify_imposta_variabile", {
  description:
    "Crea o aggiorna una variabile d'ambiente. Serve un redeploy perché abbia effetto. Non usarlo per segreti: quelli si mettono dal pannello.",
  inputSchema: {
    applicazione: z.string().describe("uuid o nome dell'applicazione"),
    chiave: z.string(),
    valore: z.string(),
  },
}, async ({ applicazione, chiave, valore }: { applicazione: string; chiave: string; valore: string }) => {
  if (CHIAVE_SEGRETA.test(chiave) || CREDENZIALI_NELL_URL.test(valore)) {
    throw new Error(
      `"${chiave}" sembra un segreto: mettilo dal pannello. Un valore riservato passato di qui finisce nel contesto della conversazione.`,
    );
  }
  const a = await trovaApp(applicazione);
  const esistenti = await api(`/applications/${a.uuid}/envs`) as Qualunque[];
  const gia = esistenti.find((e) => e.key === chiave && !e.is_preview);
  const corpo = JSON.stringify({ key: chiave, value: valore, is_preview: false });
  if (gia) {
    await api(`/applications/${a.uuid}/envs`, { method: "PATCH", body: corpo });
    return txt(`aggiornata ${chiave} su ${a.name} — serve un redeploy`);
  }
  await api(`/applications/${a.uuid}/envs`, { method: "POST", body: corpo });
  return txt(`creata ${chiave} su ${a.name} — serve un redeploy`);
});

server.registerTool("coolify_deploy", {
  description:
    "Lancia un deploy dell'applicazione e restituisce l'identificativo con cui seguirlo. Non aspetta la fine: usa coolify_deploy_stato.",
  inputSchema: {
    applicazione: z.string().describe("uuid o nome dell'applicazione"),
    forza: z.boolean().optional().describe("ricostruisce senza usare la cache"),
  },
}, async ({ applicazione, forza }: { applicazione: string; forza?: boolean }) => {
  const a = await trovaApp(applicazione);
  const r = await api(`/deploy?uuid=${a.uuid}${forza ? "&force=true" : ""}`) as Qualunque;
  const d = r?.deployments?.[0];
  return txt({ applicazione: a.name, deployment: d?.deployment_uuid, messaggio: d?.message });
});

server.registerTool("coolify_deploy_stato", {
  description:
    "Stato di un deploy. A deploy fallito restituisce la coda dei log, che è dove sta il motivo vero — Coolify li annida in JSON dentro JSON.",
  inputSchema: {
    deployment: z.string().describe("identificativo restituito da coolify_deploy"),
    righe: z.number().optional().describe("quante righe di log (default 25, solo se fallito o richiesto)"),
  },
}, async ({ deployment, righe }: { deployment: string; righe?: number }) => {
  const d = await api(`/deployments/${deployment}`) as Qualunque;
  const stato = d?.status;
  const risultato: Record<string, unknown> = { stato, applicazione: d?.application_name };
  if (stato !== "in_progress" && stato !== "queued") {
    // I log arrivano come stringa JSON dentro il JSON: srotolarli qui evita di
    // farlo a mano ogni volta, che è il motivo per cui questo tool esiste.
    try {
      const voci = JSON.parse(d?.logs ?? "[]") as Qualunque[];
      const linee = voci.map((v) => v.output).filter(Boolean);
      risultato.log = linee.slice(-(righe ?? 25));
    } catch {
      risultato.log = "log non leggibili";
    }
  }
  return txt(risultato);
});

server.registerTool("coolify_riavvia", {
  description: "Riavvia un'applicazione senza ricostruirla. Serve quando il codice va bene ma il processo è partito in un momento sbagliato.",
  inputSchema: { applicazione: z.string().describe("uuid o nome dell'applicazione") },
}, async ({ applicazione }: { applicazione: string }) => {
  const a = await trovaApp(applicazione);
  await api(`/applications/${a.uuid}/restart`);
  return txt(`riavvio chiesto per ${a.name}`);
});

await server.connect(new StdioServerTransport());
