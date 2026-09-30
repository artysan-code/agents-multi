#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run=/usr/bin/secret-tool
// coolify — MCP server sulle istanze Coolify (accounts.json, servizio "coolify"; oggi: ark).
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
// Account e token: shared/mcp/lib (accounts.json + vault). Ogni tool prende `account`,
// obbligatorio solo quando il profilo ne vede più d'uno. Il token non passa mai da un tool.
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";
import { z } from "npm:zod@^3.23";
import { CREDENTIALS_IN_URL, mask, SECRET_NAME } from "../lib/mask.ts";
import { service, text as txt } from "../lib/service.ts";

const coolify = service("coolify");

async function api(account: string | undefined, path: string, init?: RequestInit): Promise<unknown> {
  const { account: a, secret } = await coolify.use(account);
  const r = await fetch(`${a.url}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
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

// deno-lint-ignore no-explicit-any -- le risposte di Coolify non hanno uno schema pubblicato
type Qualunque = any;

/** Risolve un'applicazione da uuid o da nome, perché a memoria si tiene il nome. */
async function trovaApp(account: string | undefined, rif: string): Promise<Qualunque> {
  const apps = await api(account, "/applications") as Qualunque[];
  const per = apps.find((a) => a.uuid === rif) ??
    apps.find((a) => String(a.name ?? "").toLowerCase() === rif.toLowerCase()) ??
    apps.find((a) => String(a.name ?? "").toLowerCase().includes(rif.toLowerCase()));
  if (!per) {
    const nomi = apps.map((a) => `${a.name} (${a.uuid})`).join(", ");
    throw new Error(`nessuna applicazione per "${rif}". Ci sono: ${nomi}`);
  }
  return per;
}

const server = new McpServer({ name: "coolify", version: "0.2.0" });
const account = coolify.accountArg;

server.registerTool("coolify_risorse", {
  description:
    "Panoramica di cosa gira su Coolify: server, progetti, applicazioni (con dominio e stato) e database gestiti. Il primo tool da chiamare quando non si sa cosa c'è.",
  inputSchema: { account },
}, async ({ account }: { account?: string }) => {
  const [servers, progetti, apps, db] = await Promise.all([
    api(account, "/servers"),
    api(account, "/projects"),
    api(account, "/applications"),
    api(account, "/databases"),
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
  inputSchema: { account, applicazione: z.string().describe("uuid o nome dell'applicazione") },
}, async ({ account, applicazione }: { account?: string; applicazione: string }) => {
  const a = await trovaApp(account, applicazione);
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
  inputSchema: { account, applicazione: z.string().describe("uuid o nome dell'applicazione") },
}, async ({ account, applicazione }: { account?: string; applicazione: string }) => {
  const a = await trovaApp(account, applicazione);
  const envs = await api(account, `/applications/${a.uuid}/envs`) as Qualunque[];
  return txt(envs
    .filter((e) => !e.is_preview) // le copie di anteprima le crea Coolify da sé: rumore
    .map((e) => ({ chiave: e.key, valore: mask(e.key, e.value) })));
});

server.registerTool("coolify_imposta_variabile", {
  description:
    "Crea o aggiorna una variabile d'ambiente. Serve un redeploy perché abbia effetto. Non usarlo per segreti: quelli si mettono dal pannello.",
  inputSchema: {
    account,
    applicazione: z.string().describe("uuid o nome dell'applicazione"),
    chiave: z.string(),
    valore: z.string(),
  },
}, async ({ account, applicazione, chiave, valore }: { account?: string; applicazione: string; chiave: string; valore: string }) => {
  if (SECRET_NAME.test(chiave) || CREDENTIALS_IN_URL.test(valore)) {
    throw new Error(
      `"${chiave}" sembra un segreto: mettilo dal pannello. Un valore riservato passato di qui finisce nel contesto della conversazione.`,
    );
  }
  const a = await trovaApp(account, applicazione);
  const esistenti = await api(account, `/applications/${a.uuid}/envs`) as Qualunque[];
  const gia = esistenti.find((e) => e.key === chiave && !e.is_preview);
  const corpo = JSON.stringify({ key: chiave, value: valore, is_preview: false });
  if (gia) {
    await api(account, `/applications/${a.uuid}/envs`, { method: "PATCH", body: corpo });
    return txt(`aggiornata ${chiave} su ${a.name} — serve un redeploy`);
  }
  await api(account, `/applications/${a.uuid}/envs`, { method: "POST", body: corpo });
  return txt(`creata ${chiave} su ${a.name} — serve un redeploy`);
});

server.registerTool("coolify_deploy", {
  description:
    "Lancia un deploy dell'applicazione e restituisce l'identificativo con cui seguirlo. Non aspetta la fine: usa coolify_deploy_stato.",
  inputSchema: {
    account,
    applicazione: z.string().describe("uuid o nome dell'applicazione"),
    forza: z.boolean().optional().describe("ricostruisce senza usare la cache"),
  },
}, async ({ account, applicazione, forza }: { account?: string; applicazione: string; forza?: boolean }) => {
  const a = await trovaApp(account, applicazione);
  const r = await api(account, `/deploy?uuid=${a.uuid}${forza ? "&force=true" : ""}`) as Qualunque;
  const d = r?.deployments?.[0];
  return txt({ applicazione: a.name, deployment: d?.deployment_uuid, messaggio: d?.message });
});

server.registerTool("coolify_deploy_stato", {
  description:
    "Stato di un deploy. A deploy fallito restituisce la coda dei log, che è dove sta il motivo vero — Coolify li annida in JSON dentro JSON.",
  inputSchema: {
    account,
    deployment: z.string().describe("identificativo restituito da coolify_deploy"),
    righe: z.number().optional().describe("quante righe di log (default 25, solo se fallito o richiesto)"),
  },
}, async ({ account, deployment, righe }: { account?: string; deployment: string; righe?: number }) => {
  const d = await api(account, `/deployments/${deployment}`) as Qualunque;
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
  inputSchema: { account, applicazione: z.string().describe("uuid o nome dell'applicazione") },
}, async ({ account, applicazione }: { account?: string; applicazione: string }) => {
  const a = await trovaApp(account, applicazione);
  await api(account, `/applications/${a.uuid}/restart`);
  return txt(`riavvio chiesto per ${a.name}`);
});

await server.connect(new StdioServerTransport());
