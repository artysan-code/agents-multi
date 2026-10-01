#!/usr/bin/env -S deno run --allow-net --allow-read --allow-env --allow-run=/usr/bin/secret-tool
// coolify — MCP server sulle istanze Coolify (accounts.json, servizio "coolify"; oggi: ark, ovh).
//
// Copre il ciclo di vita intero di quello che gira su Coolify: vedere (risorse, dettagli, log,
// storico dei deploy, variabili, backup), creare (progetti, ambienti, applicazioni da git o da
// immagine, service da compose, database), cambiare (configurazione, domini, variabili), far
// girare (deploy, avvio, stop, riavvio, task programmati) e tenere in ordine (backup dei
// database, pulizia di Docker sul server). Le chiamate seguono l'OpenAPI di Coolify 4.
//
// **Non espone nessuna cancellazione, ed è una scelta.** Un `DELETE` via API costa un tool call.
// Distruggere risorse resta un gesto da fare a mano, guardando cosa si sta facendo.
//
// **Nessun segreto passa di qui, in nessuna direzione.** Le risposte sono mascherate (lib/mask.ts:
// campi, log, compose); una variabile dal nome riservato o un indirizzo con credenziali vengono
// rifiutati in scrittura; un database creato restituisce solo il suo uuid (Coolify risponde con la
// password in chiaro); delle chiavi SSH si vede il nome, mai il contenuto.
//
// Account e token: shared/mcp/lib (accounts.json + vault). Ogni tool prende `account`,
// obbligatorio solo quando il profilo ne vede più d'uno. Il token non passa mai da un tool.
import { McpServer } from "npm:@modelcontextprotocol/sdk@^1.18/server/mcp.js";
import { StdioServerTransport } from "npm:@modelcontextprotocol/sdk@^1.18/server/stdio.js";
import { z } from "npm:zod@^3.23";
import { CREDENTIALS_IN_URL, HIDDEN, mask, maskDeep, maskText, SECRET_NAME } from "../lib/mask.ts";
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
  if (!r.ok) throw new Error(`${path.split("?")[0]} → HTTP ${r.status}: ${maskText(testo.slice(0, 400))}`);
  try {
    return JSON.parse(testo);
  } catch {
    return testo;
  }
}
const post = (account: string | undefined, path: string, body?: unknown) =>
  api(account, path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const patch = (account: string | undefined, path: string, body: unknown) => api(account, path, { method: "PATCH", body: JSON.stringify(body) });

// deno-lint-ignore no-explicit-any -- le risposte di Coolify non hanno uno schema stabile tra versioni
type Qualunque = any;
type Tipo = "applicazione" | "service" | "database";
const PERCORSO: Record<Tipo, string> = { applicazione: "/applications", service: "/services", database: "/databases" };

/** Risolve una risorsa da uuid o da nome, perché a memoria si tiene il nome. */
async function trova(account: string | undefined, percorso: string, cosa: string, rif: string): Promise<Qualunque> {
  const tutte = await api(account, percorso) as Qualunque[];
  const per = tutte.find((a) => a.uuid === rif) ??
    tutte.find((a) => String(a.name ?? "").toLowerCase() === rif.toLowerCase()) ??
    tutte.find((a) => String(a.name ?? "").toLowerCase().includes(rif.toLowerCase()));
  if (!per) {
    const nomi = tutte.map((a) => `${a.name} (${a.uuid})`).join(", ") || "nessuna";
    throw new Error(`nessun ${cosa} per "${rif}". Ci sono: ${nomi}`);
  }
  return per;
}
const trovaApp = (account: string | undefined, rif: string) => trova(account, "/applications", "applicazione", rif);
const trovaDi = (account: string | undefined, tipo: Tipo, rif: string) => trova(account, PERCORSO[tipo], tipo, rif);

/** Il server dove creare: l'unico dell'istanza, finché ce n'è uno solo. */
async function unicoServer(account: string | undefined): Promise<Qualunque> {
  const servers = await api(account, "/servers") as Qualunque[];
  if (servers.length !== 1) throw new Error(`il server va scelto: ce ne sono ${servers.length}`);
  return servers[0];
}

/** Progetto e ambiente per nome o uuid, con l'uuid dell'ambiente che le creazioni vogliono. */
async function dove(account: string | undefined, progetto: string, ambiente = "production") {
  const p = await trova(account, "/projects", "progetto", progetto);
  const envs = await api(account, `/projects/${p.uuid}/environments`) as Qualunque[];
  const e = envs.find((x) => x.uuid === ambiente || String(x.name).toLowerCase() === ambiente.toLowerCase());
  if (!e) throw new Error(`nessun ambiente "${ambiente}" in ${p.name}. Ci sono: ${envs.map((x) => x.name).join(", ")}`);
  return { project_uuid: p.uuid, environment_name: e.name, environment_uuid: e.uuid, progetto: p.name };
}

/** Un valore da scrivere che non deve essere un segreto. */
function nonSegreto(chiave: string, valore: string) {
  if (SECRET_NAME.test(chiave) || CREDENTIALS_IN_URL.test(valore)) {
    throw new Error(`"${chiave}" sembra un segreto: mettilo dal pannello di Coolify. Un valore riservato passato di qui finisce nel contesto della conversazione.`);
  }
}

const server = new McpServer({ name: "coolify", version: "0.4.0" });
const account = coolify.accountArg;
const tipo = z.enum(["applicazione", "service", "database"]);
const LEGGE = { readOnlyHint: true, openWorldHint: true };
const CAMBIA = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

// ============================================================ vedere

server.registerTool("coolify_risorse", {
  description:
    "Panoramica di cosa gira su Coolify: server, progetti, applicazioni (con dominio e stato), service (i compose a più container: Forgejo, n8n, Foundry…) e database gestiti. Il primo tool da chiamare quando non si sa cosa c'è.",
  inputSchema: { account },
  annotations: LEGGE,
}, async ({ account }: { account?: string }) => {
  const [servers, progetti, apps, services, db] = await Promise.all([
    api(account, "/servers"),
    api(account, "/projects"),
    api(account, "/applications"),
    api(account, "/services"),
    api(account, "/databases"),
  ]) as Qualunque[][];
  return txt({
    server: servers.map((s) => ({ uuid: s.uuid, nome: s.name, ip: s.ip, raggiungibile: s.is_reachable })),
    progetti: progetti.map((p) => ({ uuid: p.uuid, nome: p.name })),
    applicazioni: apps.map((a) => ({ uuid: a.uuid, nome: a.name, dominio: a.fqdn ?? null, stato: a.status, ramo: a.git_branch, tipo: a.build_pack })),
    service: services.map((v) => ({ uuid: v.uuid, nome: v.name, stato: v.status })),
    database: db.map((d) => ({ uuid: d.uuid, nome: d.name, tipo: d.database_type, stato: d.status })),
  });
});

server.registerTool("coolify_versione", {
  description: "Versione dell'istanza Coolify e se risponde: utile prima di usare funzioni recenti.",
  inputSchema: { account },
  annotations: LEGGE,
}, async ({ account }: { account?: string }) => {
  const [versione, salute] = await Promise.all([api(account, "/version"), api(account, "/health").catch((e) => (e as Error).message)]);
  return txt({ versione, salute });
});

server.registerTool("coolify_dettaglio", {
  description:
    "Dettaglio di una risorsa per uuid o nome: applicazione (sorgente git, build, domini, salute, limiti), service (compose, container, domini), " +
    "database (immagine, porte, backup), server (risorse che ci girano, domini), progetto (ambienti e cosa contiene ciascuno). I valori riservati sono mascherati.",
  inputSchema: {
    account,
    tipo: z.enum(["applicazione", "service", "database", "server", "progetto"]),
    rif: z.string().describe("uuid o nome"),
  },
  annotations: LEGGE,
}, async ({ account, tipo, rif }: { account?: string; tipo: Tipo | "server" | "progetto"; rif: string }) => {
  if (tipo === "applicazione") {
    const a = await api(account, `/applications/${(await trovaApp(account, rif)).uuid}`) as Qualunque;
    return txt(maskDeep({
      uuid: a.uuid, nome: a.name, descrizione: a.description, stato: a.status, dominio: a.fqdn, domini_compose: a.docker_compose_domains,
      git: { repository: a.git_repository, ramo: a.git_branch, commit: a.git_commit_sha, auto_deploy: a.is_auto_deploy_enabled },
      build: {
        tipo: a.build_pack, base_directory: a.base_directory, dockerfile: a.dockerfile_location, compose: a.docker_compose_location,
        immagine: a.docker_registry_image_name ? `${a.docker_registry_image_name}:${a.docker_registry_image_tag ?? "latest"}` : null,
        install: a.install_command, build: a.build_command, start: a.start_command, watch_paths: a.watch_paths,
      },
      porte: { esposte: a.ports_exposes, mappate: a.ports_mappings },
      salute: { attiva: a.health_check_enabled, percorso: a.health_check_path, porta: a.health_check_port },
      limiti: { memoria: a.limits_memory, cpu: a.limits_cpus },
      // I secret dei webhook esistono sempre: dire che ci sono basta, mostrarli no.
      webhook_configurati: Object.keys(a).filter((k) => k.startsWith("manual_webhook_secret_") && a[k]),
    }));
  }
  if (tipo === "service") {
    const s = await api(account, `/services/${(await trovaDi(account, "service", rif)).uuid}`) as Qualunque;
    return txt({
      uuid: s.uuid, nome: s.name, descrizione: s.description, stato: s.status,
      container: [...(s.applications ?? []), ...(s.databases ?? [])].map((c: Qualunque) => ({ uuid: c.uuid, nome: c.name, stato: c.status, dominio: c.fqdn ?? null, immagine: c.image })),
      compose: s.docker_compose_raw ? maskText(s.docker_compose_raw) : null,
    });
  }
  if (tipo === "database") {
    const d = await api(account, `/databases/${(await trovaDi(account, "database", rif)).uuid}`) as Qualunque;
    const backup = await api(account, `/databases/${d.uuid}/backups`).catch(() => []) as Qualunque[];
    return txt(maskDeep({
      uuid: d.uuid, nome: d.name, tipo: d.database_type, stato: d.status, immagine: d.image,
      pubblico: d.is_public, porta_pubblica: d.public_port, limiti: { memoria: d.limits_memory, cpu: d.limits_cpus },
      indirizzo_interno: d.internal_db_url ? maskText(d.internal_db_url) : null,
      backup: backup.map((b) => ({ uuid: b.uuid, frequenza: b.frequency, attivo: b.enabled, s3: b.save_s3 })),
    }));
  }
  if (tipo === "server") {
    const s = await trova(account, "/servers", "server", rif);
    const [risorse, domini] = await Promise.all([
      api(account, `/servers/${s.uuid}/resources`).catch(() => []),
      api(account, `/servers/${s.uuid}/domains`).catch(() => []),
    ]) as Qualunque[][];
    return txt({
      uuid: s.uuid, nome: s.name, ip: s.ip, raggiungibile: s.is_reachable, utilizzabile: s.is_usable, proxy: s.proxy?.type ?? s.proxy_type,
      risorse: risorse.map((r) => ({ uuid: r.uuid, nome: r.name, tipo: r.type, stato: r.status })),
      domini,
    });
  }
  const p = await trova(account, "/projects", "progetto", rif);
  const envs = await api(account, `/projects/${p.uuid}/environments`) as Qualunque[];
  const dentro = await Promise.all(envs.map(async (e) => {
    const x = await api(account, `/projects/${p.uuid}/${e.uuid}`).catch(() => ({})) as Qualunque;
    const nomi = (k: string) => (x[k] ?? []).map((r: Qualunque) => r.name);
    return { ambiente: e.name, uuid: e.uuid, applicazioni: nomi("applications"), service: nomi("services"), database: [...nomi("postgresqls"), ...nomi("redis"), ...nomi("mysqls"), ...nomi("mariadbs"), ...nomi("mongodbs")] };
  }));
  return txt({ uuid: p.uuid, nome: p.name, descrizione: p.description, ambienti: dentro });
});

server.registerTool("coolify_log", {
  description:
    "Le ultime righe di log dei container: di un'applicazione, di un service (tutti i container, o uno con `container`) o di un database. " +
    "Il posto dove guardare quando qualcosa gira ma non funziona. I valori riservati nelle righe sono mascherati.",
  inputSchema: {
    account, tipo, rif: z.string().describe("uuid o nome"),
    righe: z.number().int().min(1).max(1000).optional().describe("default 100"),
    container: z.string().optional().describe("per un service: il nome del servizio nel compose"),
  },
  annotations: LEGGE,
}, async ({ account, tipo, rif, righe, container }: { account?: string; tipo: Tipo; rif: string; righe?: number; container?: string }) => {
  const r = await trovaDi(account, tipo, rif);
  const q = new URLSearchParams({ lines: String(righe ?? 100) });
  if (tipo === "service" && container) q.set("sub_service_name", container);
  const l = await api(account, `${PERCORSO[tipo]}/${r.uuid}/logs?${q}`) as Qualunque;
  const testo = typeof l === "string" ? l : l?.logs ?? JSON.stringify(l);
  return txt({ risorsa: r.name, log: maskText(String(testo)).split("\n").slice(-(righe ?? 100)) });
});

server.registerTool("coolify_variabili", {
  description: "Variabili d'ambiente di un'applicazione, un service o un database. I valori che sembrano riservati sono mascherati.",
  inputSchema: { account, tipo: tipo.optional().describe("default applicazione"), rif: z.string().describe("uuid o nome") },
  annotations: LEGGE,
}, async ({ account, tipo, rif }: { account?: string; tipo?: Tipo; rif: string }) => {
  const t = tipo ?? "applicazione";
  const r = await trovaDi(account, t, rif);
  const envs = await api(account, `${PERCORSO[t]}/${r.uuid}/envs`) as Qualunque[];
  return txt(envs
    .filter((e) => !e.is_preview) // le copie di anteprima le crea Coolify da sé: rumore
    .map((e) => ({ chiave: e.key, valore: e.is_shown_once ? HIDDEN : mask(e.key, e.value), ...(e.is_build_time ? { build: true } : {}) })));
});

server.registerTool("coolify_deploy_storico", {
  description: "Gli ultimi deploy di un'applicazione: quando, con che commit, com'è finito. Per i log di uno, coolify_deploy_stato.",
  inputSchema: { account, applicazione: z.string().describe("uuid o nome"), quanti: z.number().int().min(1).max(50).optional() },
  annotations: LEGGE,
}, async ({ account, applicazione, quanti }: { account?: string; applicazione: string; quanti?: number }) => {
  const a = await trovaApp(account, applicazione);
  const r = await api(account, `/deployments/applications/${a.uuid}?take=${quanti ?? 10}`) as Qualunque;
  const lista = (Array.isArray(r) ? r : r?.deployments ?? []) as Qualunque[];
  return txt(lista.map((d) => ({ deployment: d.deployment_uuid, stato: d.status, commit: d.commit?.slice?.(0, 10) ?? null, messaggio: d.commit_message ?? null, inizio: d.created_at, fine: d.updated_at })));
});

server.registerTool("coolify_deploy_stato", {
  description:
    "Stato di un deploy. A deploy fallito restituisce la coda dei log, che è dove sta il motivo vero — Coolify li annida in JSON dentro JSON.",
  inputSchema: {
    account,
    deployment: z.string().describe("identificativo restituito da coolify_deploy"),
    righe: z.number().optional().describe("quante righe di log (default 25, solo se finito)"),
  },
  annotations: LEGGE,
}, async ({ account, deployment, righe }: { account?: string; deployment: string; righe?: number }) => {
  const d = await api(account, `/deployments/${deployment}`) as Qualunque;
  const stato = d?.status;
  const risultato: Record<string, unknown> = { stato, applicazione: d?.application_name };
  if (stato !== "in_progress" && stato !== "queued") {
    try {
      const voci = JSON.parse(d?.logs ?? "[]") as Qualunque[];
      risultato.log = voci.map((v) => v.output).filter(Boolean).slice(-(righe ?? 25)).map((l: string) => maskText(l));
    } catch {
      risultato.log = "log non leggibili";
    }
  }
  return txt(risultato);
});

server.registerTool("coolify_chiavi", {
  description: "Le chiavi SSH private salvate in Coolify, per nome e uuid (mai il contenuto): servono per creare un'applicazione da un repository privato con deploy key.",
  inputSchema: { account },
  annotations: LEGGE,
}, async ({ account }: { account?: string }) => {
  const k = await api(account, "/security/keys") as Qualunque[];
  return txt(k.map((x) => ({ uuid: x.uuid, nome: x.name, descrizione: x.description ?? null, git: x.is_git_related ?? null })));
});

// ============================================================ creare

server.registerTool("coolify_crea_progetto", {
  description:
    "Crea un progetto. Coolify gli crea da sé l'ambiente «production». Se un progetto con lo stesso nome c'è già, restituisce quello invece di farne un doppione.",
  inputSchema: { account, nome: z.string(), descrizione: z.string().optional() },
  annotations: CAMBIA,
}, async ({ account, nome, descrizione }: { account?: string; nome: string; descrizione?: string }) => {
  const progetti = await api(account, "/projects") as Qualunque[];
  const gia = progetti.find((p) => String(p.name).toLowerCase() === nome.toLowerCase());
  if (gia) return txt({ progetto: gia.uuid, nome: gia.name, creato: false });
  const r = await post(account, "/projects", { name: nome, ...(descrizione ? { description: descrizione } : {}) }) as Qualunque;
  return txt({ progetto: r.uuid, nome, creato: true, ambiente: "production" });
});

server.registerTool("coolify_crea_ambiente", {
  description: "Aggiunge un ambiente (staging, test…) a un progetto. Se c'è già, lo restituisce.",
  inputSchema: { account, progetto: z.string().describe("uuid o nome"), nome: z.string() },
  annotations: CAMBIA,
}, async ({ account, progetto, nome }: { account?: string; progetto: string; nome: string }) => {
  const p = await trova(account, "/projects", "progetto", progetto);
  const envs = await api(account, `/projects/${p.uuid}/environments`) as Qualunque[];
  const gia = envs.find((e) => String(e.name).toLowerCase() === nome.toLowerCase());
  if (gia) return txt({ ambiente: gia.uuid, nome: gia.name, creato: false });
  const r = await post(account, `/projects/${p.uuid}/environments`, { name: nome }) as Qualunque;
  return txt({ ambiente: r.uuid, nome, progetto: p.name, creato: true });
});

server.registerTool("coolify_crea_applicazione", {
  description:
    "Crea un'applicazione: da un repository git pubblico, da uno privato con una deploy key salvata in Coolify (coolify_chiavi), o da un'immagine Docker. " +
    "Il build può essere nixpacks, dockerfile, dockercompose o static. Di default non la avvia: controlla la configurazione, poi coolify_deploy.",
  inputSchema: {
    account,
    progetto: z.string().describe("uuid o nome"),
    ambiente: z.string().optional().describe("default production"),
    nome: z.string(),
    descrizione: z.string().optional(),
    sorgente: z.enum(["git_pubblico", "git_chiave", "immagine"]),
    repository: z.string().optional().describe("per git: https://… (pubblico) o git@host:owner/repo.git / ssh://git@host:porta/owner/repo.git (con chiave)"),
    ramo: z.string().optional().describe("per git, default main"),
    chiave: z.string().optional().describe("per git_chiave: uuid o nome della chiave in Coolify"),
    build: z.enum(["nixpacks", "railpack", "dockerfile", "dockercompose", "static"]).optional().describe("per git, default nixpacks"),
    base_directory: z.string().optional().describe("default /"),
    dockerfile: z.string().optional().describe("percorso del Dockerfile, default /Dockerfile"),
    compose: z.string().optional().describe("percorso del compose per build dockercompose, default /docker-compose.yaml"),
    immagine: z.string().optional().describe("per immagine: nome, es. ghcr.io/owner/app"),
    tag: z.string().optional().describe("per immagine, default latest"),
    porte: z.string().optional().describe("porte esposte dal container, es. 8080"),
    dominio: z.string().optional().describe("https://… (più domini separati da virgola); non per dockercompose"),
    domini_compose: z.array(z.object({ servizio: z.string(), dominio: z.string() })).optional().describe("per dockercompose: dominio di ogni servizio del compose"),
    avvia: z.boolean().optional(),
  },
  annotations: CAMBIA,
}, async (a: {
  account?: string; progetto: string; ambiente?: string; nome: string; descrizione?: string; sorgente: "git_pubblico" | "git_chiave" | "immagine";
  repository?: string; ramo?: string; chiave?: string; build?: string; base_directory?: string; dockerfile?: string; compose?: string;
  immagine?: string; tag?: string; porte?: string; dominio?: string; domini_compose?: { servizio: string; dominio: string }[]; avvia?: boolean;
}) => {
  if (a.repository && CREDENTIALS_IN_URL.test(a.repository)) throw new Error("il repository contiene credenziali: usa una deploy key (sorgente git_chiave)");
  const w = await dove(a.account, a.progetto, a.ambiente);
  const s = await unicoServer(a.account);
  const corpo: Record<string, unknown> = {
    project_uuid: w.project_uuid, environment_name: w.environment_name, environment_uuid: w.environment_uuid, server_uuid: s.uuid,
    name: a.nome, ...(a.descrizione ? { description: a.descrizione } : {}),
    ...(a.porte ? { ports_exposes: a.porte } : {}),
    ...(a.dominio ? { domains: a.dominio } : {}),
    instant_deploy: a.avvia ?? false,
  };
  let percorso: string;
  if (a.sorgente === "immagine") {
    if (!a.immagine) throw new Error("serve `immagine`");
    percorso = "/applications/dockerimage";
    Object.assign(corpo, { docker_registry_image_name: a.immagine, docker_registry_image_tag: a.tag ?? "latest" });
  } else {
    if (!a.repository) throw new Error("serve `repository`");
    Object.assign(corpo, {
      git_repository: a.repository, git_branch: a.ramo ?? "main", build_pack: a.build ?? "nixpacks",
      ...(a.base_directory ? { base_directory: a.base_directory } : {}),
      ...(a.dockerfile ? { dockerfile_location: a.dockerfile } : {}),
      ...(a.compose ? { docker_compose_location: a.compose } : {}),
      ...(a.domini_compose?.length ? { docker_compose_domains: a.domini_compose.map((d) => ({ name: d.servizio, domain: d.dominio })) } : {}),
    });
    if (a.sorgente === "git_chiave") {
      if (!a.chiave) throw new Error("serve `chiave` (coolify_chiavi le elenca)");
      corpo.private_key_uuid = (await trova(a.account, "/security/keys", "chiave", a.chiave)).uuid;
      percorso = "/applications/private-deploy-key";
    } else percorso = "/applications/public";
  }
  const r = await post(a.account, percorso, corpo) as Qualunque;
  return txt({ applicazione: r.uuid, nome: a.nome, progetto: w.progetto, ambiente: w.environment_name, domini: r.domains ?? a.dominio ?? null, avviata: corpo.instant_deploy });
});

server.registerTool("coolify_crea_service", {
  description:
    "Crea un service da un docker compose dentro progetto e ambiente. Di default non lo avvia. I segreti non vanno scritti nel compose: si usano le variabili magiche di Coolify ($SERVICE_PASSWORD_<NOME>, $SERVICE_USER_<NOME>), che le genera lui e non passano di qui.",
  inputSchema: {
    account,
    progetto: z.string().describe("uuid o nome del progetto"),
    ambiente: z.string().optional().describe("nome dell'ambiente (default production)"),
    nome: z.string(),
    descrizione: z.string().optional(),
    compose: z.string().describe("il docker-compose in YAML, in chiaro: la codifica base64 la fa il tool"),
    domini: z.array(z.object({
      container: z.string().describe("nome del servizio nel compose"),
      url: z.string().describe("es. https://git.example.com"),
    })).optional(),
    avvia: z.boolean().optional().describe("avvia subito dopo la creazione (default no)"),
  },
  annotations: CAMBIA,
}, async (
  { account, progetto, ambiente, nome, descrizione, compose, domini, avvia }: {
    account?: string; progetto: string; ambiente?: string; nome: string; descrizione?: string; compose: string;
    domini?: { container: string; url: string }[]; avvia?: boolean;
  },
) => {
  if (CREDENTIALS_IN_URL.test(compose)) {
    throw new Error("il compose contiene credenziali in un indirizzo: usa le variabili $SERVICE_USER_* / $SERVICE_PASSWORD_*");
  }
  const w = await dove(account, progetto, ambiente);
  const s = await unicoServer(account);
  const corpo = {
    name: nome,
    ...(descrizione ? { description: descrizione } : {}),
    project_uuid: w.project_uuid,
    environment_name: w.environment_name,
    environment_uuid: w.environment_uuid,
    server_uuid: s.uuid,
    docker_compose_raw: btoa(String.fromCodePoint(...new TextEncoder().encode(compose))),
    ...(domini?.length ? { urls: domini.map((d) => ({ name: d.container, url: d.url })) } : {}),
    instant_deploy: avvia ?? false,
  };
  // Della risposta si tiene uuid e domini: nient'altro, nel caso un giorno ci finisca una password.
  const r = await post(account, "/services", corpo) as Qualunque;
  return txt({ service: r.uuid, progetto: w.progetto, ambiente: w.environment_name, domini: r.domains, avviato: corpo.instant_deploy });
});

server.registerTool("coolify_crea_database", {
  description:
    "Crea un database gestito (PostgreSQL, Redis, MariaDB, MySQL, MongoDB, KeyDB, DragonFly, ClickHouse). Le credenziali le genera Coolify e restano nel suo pannello: " +
    "qui torna solo l'uuid. Non è esposto su internet, salvo chiederlo.",
  inputSchema: {
    account,
    motore: z.enum(["postgresql", "redis", "mariadb", "mysql", "mongodb", "keydb", "dragonfly", "clickhouse"]),
    progetto: z.string().describe("uuid o nome"),
    ambiente: z.string().optional(),
    nome: z.string(),
    immagine: z.string().optional().describe("es. postgres:17-alpine; default quella di Coolify"),
    memoria: z.string().optional().describe("limite di memoria, es. 512m"),
    pubblico: z.boolean().optional().describe("esposto su una porta pubblica (default no)"),
    porta_pubblica: z.number().int().optional(),
    avvia: z.boolean().optional(),
  },
  annotations: CAMBIA,
}, async (a: { account?: string; motore: string; progetto: string; ambiente?: string; nome: string; immagine?: string; memoria?: string; pubblico?: boolean; porta_pubblica?: number; avvia?: boolean }) => {
  const w = await dove(a.account, a.progetto, a.ambiente);
  const s = await unicoServer(a.account);
  const r = await post(a.account, `/databases/${a.motore}`, {
    server_uuid: s.uuid, project_uuid: w.project_uuid, environment_name: w.environment_name, environment_uuid: w.environment_uuid,
    name: a.nome, ...(a.immagine ? { image: a.immagine } : {}), ...(a.memoria ? { limits_memory: a.memoria } : {}),
    is_public: a.pubblico ?? false, ...(a.porta_pubblica ? { public_port: a.porta_pubblica } : {}), instant_deploy: a.avvia ?? false,
  }) as Qualunque;
  // Coolify risponde con la password e l'indirizzo completo: si tiene l'uuid e basta.
  return txt({ database: r.uuid, motore: a.motore, nome: a.nome, progetto: w.progetto, avviato: a.avvia ?? false, credenziali: "nel pannello di Coolify" });
});

// ============================================================ cambiare

/** I campi di un'applicazione che si cambiano di qui: niente segreti (basic auth, webhook). */
const CAMPI_APP = [
  "name", "description", "domains", "git_repository", "git_branch", "git_commit_sha", "build_pack", "base_directory", "publish_directory",
  "dockerfile_location", "docker_compose_location", "docker_compose_domains", "docker_registry_image_name", "docker_registry_image_tag",
  "ports_exposes", "ports_mappings", "install_command", "build_command", "start_command", "watch_paths", "is_auto_deploy_enabled",
  "is_force_https_enabled", "redirect", "health_check_enabled", "health_check_path", "health_check_port", "health_check_interval",
  "health_check_timeout", "health_check_retries", "health_check_start_period", "limits_memory", "limits_cpus", "pre_deployment_command",
  "pre_deployment_command_container", "post_deployment_command", "post_deployment_command_container", "custom_labels", "is_static", "is_spa",
  "disable_build_cache", "docker_images_to_keep", "stop_grace_period",
];

server.registerTool("coolify_aggiorna_applicazione", {
  description:
    "Cambia la configurazione di un'applicazione: domini, ramo, percorsi di Dockerfile o compose, porte, comandi, controllo di salute, limiti, auto deploy… " +
    `I campi sono quelli dell'API di Coolify (${CAMPI_APP.join(", ")}). Serve un deploy perché abbia effetto.`,
  inputSchema: {
    account,
    applicazione: z.string().describe("uuid o nome"),
    campi: z.record(z.unknown()).describe("es. { \"domains\": \"https://brain.example.com\", \"git_branch\": \"release\" }"),
  },
  annotations: CAMBIA,
}, async ({ account, applicazione, campi }: { account?: string; applicazione: string; campi: Record<string, unknown> }) => {
  const fuori = Object.keys(campi).filter((k) => !CAMPI_APP.includes(k));
  if (fuori.length) throw new Error(`campi non ammessi qui: ${fuori.join(", ")}. Ammessi: ${CAMPI_APP.join(", ")}`);
  for (const [k, v] of Object.entries(campi)) if (typeof v === "string") nonSegreto(k, v);
  const a = await trovaApp(account, applicazione);
  await patch(account, `/applications/${a.uuid}`, campi);
  return txt(`aggiornati ${Object.keys(campi).join(", ")} su ${a.name} — serve un deploy`);
});

server.registerTool("coolify_aggiorna_service", {
  description: "Cambia un service: il compose (intero, in chiaro), i domini dei container, nome e descrizione. Serve un riavvio perché abbia effetto.",
  inputSchema: {
    account,
    service: z.string().describe("uuid o nome"),
    compose: z.string().optional(),
    domini: z.array(z.object({ container: z.string(), url: z.string() })).optional(),
    nome: z.string().optional(),
    descrizione: z.string().optional(),
  },
  annotations: CAMBIA,
}, async ({ account, service, compose, domini, nome, descrizione }: { account?: string; service: string; compose?: string; domini?: { container: string; url: string }[]; nome?: string; descrizione?: string }) => {
  if (compose && CREDENTIALS_IN_URL.test(compose)) throw new Error("il compose contiene credenziali in un indirizzo: usa le variabili $SERVICE_*");
  if (compose?.includes(HIDDEN)) throw new Error("il compose contiene valori mascherati: riscrivilo senza, o cambia solo quello che serve dal pannello");
  const s = await trovaDi(account, "service", service);
  await patch(account, `/services/${s.uuid}`, {
    ...(compose ? { docker_compose_raw: btoa(String.fromCodePoint(...new TextEncoder().encode(compose))) } : {}),
    ...(domini?.length ? { urls: domini.map((d) => ({ name: d.container, url: d.url })) } : {}),
    ...(nome ? { name: nome } : {}),
    ...(descrizione ? { description: descrizione } : {}),
  });
  return txt(`aggiornato ${s.name} — serve un riavvio`);
});

server.registerTool("coolify_imposta_variabile", {
  description:
    "Crea o aggiorna una variabile d'ambiente di un'applicazione, un service o un database. Serve un redeploy o un riavvio perché abbia effetto. Non per segreti: quelli si mettono dal pannello.",
  inputSchema: {
    account,
    tipo: tipo.optional().describe("default applicazione"),
    rif: z.string().describe("uuid o nome della risorsa"),
    chiave: z.string(),
    valore: z.string(),
    letterale: z.boolean().optional().describe("non interpretare $VARIABILI dentro il valore"),
    multilinea: z.boolean().optional(),
  },
  annotations: CAMBIA,
}, async ({ account, tipo, rif, chiave, valore, letterale, multilinea }: { account?: string; tipo?: Tipo; rif: string; chiave: string; valore: string; letterale?: boolean; multilinea?: boolean }) => {
  nonSegreto(chiave, valore);
  const t = tipo ?? "applicazione";
  const r = await trovaDi(account, t, rif);
  const base = `${PERCORSO[t]}/${r.uuid}/envs`;
  const esistenti = await api(account, base) as Qualunque[];
  const gia = esistenti.find((e) => e.key === chiave && !e.is_preview);
  const corpo = { key: chiave, value: valore, is_preview: false, ...(letterale !== undefined ? { is_literal: letterale } : {}), ...(multilinea !== undefined ? { is_multiline: multilinea } : {}) };
  await api(account, base, { method: gia ? "PATCH" : "POST", body: JSON.stringify(corpo) });
  return txt(`${gia ? "aggiornata" : "creata"} ${chiave} su ${r.name} — serve un ${t === "applicazione" ? "redeploy" : "riavvio"}`);
});

// ============================================================ far girare

server.registerTool("coolify_deploy", {
  description:
    "Lancia un deploy dell'applicazione e restituisce l'identificativo con cui seguirlo. Non aspetta la fine: usa coolify_deploy_stato.",
  inputSchema: {
    account,
    applicazione: z.string().describe("uuid o nome dell'applicazione"),
    forza: z.boolean().optional().describe("ricostruisce senza usare la cache"),
  },
  annotations: CAMBIA,
}, async ({ account, applicazione, forza }: { account?: string; applicazione: string; forza?: boolean }) => {
  const a = await trovaApp(account, applicazione);
  // Da Coolify 4.3 le azioni sono POST: il GET risponde 405 «endpoint has changed to a POST request».
  const r = await post(account, `/deploy?uuid=${a.uuid}${forza ? "&force=true" : ""}`) as Qualunque;
  const d = r?.deployments?.[0];
  return txt({ applicazione: a.name, deployment: d?.deployment_uuid, messaggio: d?.message });
});

server.registerTool("coolify_annulla_deploy", {
  description: "Ferma un deploy in coda o in corso.",
  inputSchema: { account, deployment: z.string() },
  annotations: CAMBIA,
}, async ({ account, deployment }: { account?: string; deployment: string }) => {
  const r = await post(account, `/deployments/${deployment}/cancel`) as Qualunque;
  return txt({ deployment, messaggio: r?.message ?? r });
});

server.registerTool("coolify_azione", {
  description: "Avvia, ferma o riavvia un'applicazione, un service o un database, senza ricostruire. Per ricostruire un'applicazione, coolify_deploy.",
  inputSchema: { account, tipo, rif: z.string().describe("uuid o nome"), azione: z.enum(["avvia", "ferma", "riavvia"]) },
  annotations: CAMBIA,
}, async ({ account, tipo, rif, azione }: { account?: string; tipo: Tipo; rif: string; azione: "avvia" | "ferma" | "riavvia" }) => {
  const r = await trovaDi(account, tipo, rif);
  const verbo = { avvia: "start", ferma: "stop", riavvia: "restart" }[azione];
  const x = await post(account, `${PERCORSO[tipo]}/${r.uuid}/${verbo}`) as Qualunque;
  return txt({ risorsa: r.name, azione, messaggio: x?.message ?? x });
});

server.registerTool("coolify_task_programmati", {
  description:
    "I comandi pianificati dentro un'applicazione o un service (cron di Coolify): elencarli, crearne uno, lanciarne uno adesso, vedere le ultime esecuzioni.",
  inputSchema: {
    account,
    tipo: z.enum(["applicazione", "service"]),
    rif: z.string().describe("uuid o nome"),
    azione: z.enum(["elenca", "crea", "esegui", "esecuzioni"]),
    task: z.string().optional().describe("per esegui/esecuzioni: uuid o nome del task"),
    nome: z.string().optional(), comando: z.string().optional(), frequenza: z.string().optional().describe("cron, es. 0 3 * * *, o @daily"),
    container: z.string().optional().describe("per un service: il container dove gira"),
  },
  annotations: CAMBIA,
}, async (a: { account?: string; tipo: "applicazione" | "service"; rif: string; azione: string; task?: string; nome?: string; comando?: string; frequenza?: string; container?: string }) => {
  const r = await trovaDi(a.account, a.tipo, a.rif);
  const base = `${PERCORSO[a.tipo]}/${r.uuid}/scheduled-tasks`;
  if (a.azione === "elenca") {
    const l = await api(a.account, base) as Qualunque[];
    return txt(l.map((x) => ({ uuid: x.uuid, nome: x.name, comando: maskText(String(x.command ?? "")), frequenza: x.frequency, attivo: x.enabled, container: x.container })));
  }
  if (a.azione === "crea") {
    if (!a.nome || !a.comando || !a.frequenza) throw new Error("servono nome, comando e frequenza");
    if (CREDENTIALS_IN_URL.test(a.comando) || maskText(a.comando) !== a.comando) throw new Error("il comando contiene un segreto: mettilo in una variabile dal pannello");
    const x = await post(a.account, base, { name: a.nome, command: a.comando, frequency: a.frequenza, ...(a.container ? { container: a.container } : {}), enabled: true }) as Qualunque;
    return txt({ task: x.uuid, nome: a.nome, frequenza: a.frequenza });
  }
  if (!a.task) throw new Error("serve `task`");
  const t = await trova(a.account, base, "task", a.task);
  if (a.azione === "esegui") return txt({ task: t.name, messaggio: (await post(a.account, `${base}/${t.uuid}/execute`) as Qualunque)?.message ?? "lanciato" });
  const ex = await api(a.account, `${base}/${t.uuid}/executions`) as Qualunque[];
  return txt(ex.slice(0, 10).map((e) => ({ stato: e.status, inizio: e.created_at, fine: e.finished_at ?? e.updated_at, output: maskText(String(e.message ?? "")).slice(-500) })));
});

// ============================================================ tenere in ordine

server.registerTool("coolify_backup_database", {
  description:
    "I backup di un database gestito: vedere quelli programmati e le ultime esecuzioni, o programmarne uno (frequenza cron, quanti tenerne, " +
    "su S3 se c'è uno storage configurato in Coolify), lanciandolo anche subito.",
  inputSchema: {
    account,
    database: z.string().describe("uuid o nome"),
    azione: z.enum(["elenca", "programma"]),
    frequenza: z.string().optional().describe("cron o @daily/@weekly; per programma"),
    tenere: z.number().int().min(1).optional().describe("quanti backup tenere sul server (default 7)"),
    s3: z.string().optional().describe("uuid o nome dello storage S3 di Coolify"),
    subito: z.boolean().optional().describe("ne fa uno adesso"),
  },
  annotations: CAMBIA,
}, async (a: { account?: string; database: string; azione: "elenca" | "programma"; frequenza?: string; tenere?: number; s3?: string; subito?: boolean }) => {
  const d = await trovaDi(a.account, "database", a.database);
  if (a.azione === "elenca") {
    const b = await api(a.account, `/databases/${d.uuid}/backups`) as Qualunque[];
    const conEsecuzioni = await Promise.all(b.map(async (x) => ({
      uuid: x.uuid, frequenza: x.frequency, attivo: x.enabled, s3: x.save_s3,
      ultime: ((await api(a.account, `/databases/${d.uuid}/backups/${x.uuid}/executions`).catch(() => [])) as Qualunque[])
        .slice(0, 5).map((e) => ({ stato: e.status, quando: e.created_at, dimensione: e.size ?? null })),
    })));
    return txt({ database: d.name, backup: conEsecuzioni });
  }
  if (!a.frequenza) throw new Error("serve `frequenza`");
  const s3 = a.s3 ? await trova(a.account, "/s3-storages", "storage S3", a.s3) : null;
  const r = await post(a.account, `/databases/${d.uuid}/backups`, {
    frequency: a.frequenza, enabled: true, database_backup_retention_amount_locally: a.tenere ?? 7,
    save_s3: !!s3, ...(s3 ? { s3_storage_uuid: s3.uuid } : {}), backup_now: a.subito ?? false,
  }) as Qualunque;
  return txt({ database: d.name, backup: r?.uuid ?? r, frequenza: a.frequenza, s3: s3?.name ?? null, subito: a.subito ?? false });
});

server.registerTool("coolify_pulizia_docker", {
  description:
    "Libera disco sul server: immagini, container fermi e cache di build che Docker non usa più. Con volumi=true anche i volumi non collegati a nulla " +
    "(attenzione: un volume di un'app ferma è «non usato»). Senza argomenti mostra prima le impostazioni e le ultime pulizie.",
  inputSchema: {
    account,
    esegui: z.boolean().optional().describe("true per lanciarla; altrimenti solo lo stato"),
    volumi: z.boolean().optional(),
    reti: z.boolean().optional(),
  },
  annotations: { ...CAMBIA, destructiveHint: true },
}, async ({ account, esegui, volumi, reti }: { account?: string; esegui?: boolean; volumi?: boolean; reti?: boolean }) => {
  const s = await unicoServer(account);
  if (!esegui) {
    const [impostazioni, ultime] = await Promise.all([
      api(account, `/servers/${s.uuid}/docker-cleanup`).catch((e) => (e as Error).message),
      api(account, `/servers/${s.uuid}/docker-cleanup/executions`).catch(() => []),
    ]);
    return txt({ server: s.name, impostazioni, ultime: (ultime as Qualunque[]).slice?.(0, 5) ?? ultime });
  }
  const r = await post(account, `/servers/${s.uuid}/docker-cleanup/run`, { delete_unused_volumes: volumi ?? false, delete_unused_networks: reti ?? false }) as Qualunque;
  return txt({ server: s.name, messaggio: r?.message ?? r });
});

await server.connect(new StdioServerTransport());
