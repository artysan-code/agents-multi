---
title: Ospitare il brain
description: Esegui il tuo brain su un server con Docker, crea il primo account e collega le tue macchine e Claude.
---

Il [brain](/it/docs/brain/) è facoltativo. Se vuoi memoria e task condivise da ogni Claude che usi, lo
esegui su un tuo server; nessun altro ha i tuoi dati.

Ogni release pubblica l'immagine del brain, `ghcr.io/artysan-code/agents-multi-brain`: `:latest` segue
le versioni stabili, `:X.Y.Z` e `:X.Y` restano dove sono.

## Cosa serve

- Un server con **Docker** e Docker Compose.
- Un **dominio con TLS** davanti alla porta 8080 (un reverse proxy, Coolify, Cloudflare…). OAuth
  indica l'indirizzo esatto, quindi deve essere quello pubblico in `https://`.
- Circa **2 GB di memoria** liberi per il modello di embedding (`bge-m3`, circa 1,2 GB su disco), che
  gira in un container Ollama accanto al brain.

## Avviarlo

Prendi il file compose dal repository e metti le impostazioni in un `.env` accanto:

```bash
mkdir brain && cd brain
curl -fsSLO https://raw.githubusercontent.com/artysan-code/agents-multi/release/apps/brain/compose.yaml
```

```bash
# .env
BRAIN_URL=https://brain.example.com
BRAIN_MASTER_KEY=<head -c32 /dev/urandom | base64>
BRAIN_ADMIN_ID=me
AGENTS_MULTI_OWNER_ID=me
AGENTS_MULTI_OWNER_NAME=Your name
AGENTS_MULTI_LANGUAGE=English
BRAIN_BACKUP_KEY=<head -c32 /dev/urandom | base64>
```

```bash
docker compose up -d
```

Il primo avvio scarica l'immagine e il modello di embedding, che va in un volume a parte, quindi ci
vuole un po'. Per fissare una versione, metti `BRAIN_IMAGE=ghcr.io/artysan-code/agents-multi-brain:0.18`
nel `.env`; per compilare dai sorgenti, `docker build -f apps/brain/Dockerfile -t brain .` dalla radice
di un clone e `BRAIN_IMAGE=brain`. `/ready` risponde quando il servizio è su. I segreti li crei e li
scrivi tu, non restano mai nel repository.

## Le variabili

Da [`compose.yaml`](https://github.com/artysan-code/agents-multi/blob/release/apps/brain/compose.yaml):

| Variabile | Cosa fa |
| --- | --- |
| `BRAIN_URL` | l'indirizzo pubblico, `https://brain.example.com` |
| `BRAIN_MASTER_KEY` | 32 byte casuali, in base64. Cifra il segreto TOTP e la chiave di backup di ogni account. **Se la perdi, quelli sono persi** |
| `BRAIN_ADMIN_ID` | l'id del primo account (l'amministratore) |
| `AGENTS_MULTI_OWNER_ID`, `AGENTS_MULTI_OWNER_NAME`, `AGENTS_MULTI_LANGUAGE` | di chi è questo brain: il proprietario predefinito di una task, il nome e la lingua |
| `BRAIN_BACKUP_KEY` | 32 byte casuali, in base64. Sigilla le copie giornaliere del server; senza, non se ne fanno |
| `BRAIN_BACKUP_KEEP` | quante copie giornaliere restano (predefinito `7`) |
| `BRAIN_EMBED_URL`, `BRAIN_EMBED_MODEL` | il servizio e il modello di embedding (`http://ollama:11434`, `bge-m3`) |
| `BRAIN_TIMEZONE` | il fuso per i giorni di un account che non ha scelto il suo (`Europe/Rome` per impostazione predefinita) |
| `BRAIN_CLIENT_IP_HEADER` | l'header in cui il tuo proxy mette l'indirizzo del client, per i limiti di frequenza (`cf-connecting-ip` dietro Cloudflare) |
| `BRAIN_LOG_LEVEL` | `debug`, `info`, `warn` o `error` (predefinito `info`) |
| `BRAIN_OPERATOR`, `BRAIN_CONTACT`, `BRAIN_HOSTING` | cosa dicono le pagine pubbliche su chi gestisce l'istanza |
| `BRAIN_SITE_URL` | un indirizzo tutto suo per il sito, quando ne vuoi uno |

I dati stanno nel volume `brain-data`. Metti il proxy TLS davanti alla porta 8080 e, se è Cloudflare,
imposta `BRAIN_CLIENT_IP_HEADER` e lascia raggiungere il server solo a Cloudflare.

## Il primo amministratore e gli inviti

Al primo avvio, quando non ci sono account, il servizio crea l'amministratore con l'id `BRAIN_ADMIN_ID`
come **invito**: il suo link viene scritto nel log del servizio (uno nuovo a ogni avvio finché non viene
accettato). Aprilo, aggiungi il segreto TOTP alla tua app di autenticazione, scegli una passphrase e
conferma con un codice. Nell'ambiente non c'è nulla di segreto.

Gli account esistono solo su invito. Da una shell sul server:

```bash
docker compose exec brain brain-admin list
docker compose exec brain brain-admin create <id> <name> --language English
```

`create` stampa un link monouso, valido sette giorni. `reset <id>` è la via di ritorno dopo aver perso
un'app di autenticazione; `disable`, `enable`, `unlock`, `stats` e `delete` sono nel
[README del brain](https://github.com/artysan-code/agents-multi/tree/release/apps/brain#readme).

## Copie di sicurezza

Con `BRAIN_BACKUP_KEY` impostata, il servizio sigilla ogni giorno una copia di ogni database in
`/data/backups` e tiene le ultime `BRAIN_BACKUP_KEEP`. Stanno sullo stesso volume del brain, quindi
coprono una scrittura sbagliata o un account cancellato, non la perdita del server. Anche le tue
macchine scaricano una copia sigillata a ogni cambiamento del brain (`agents brain-backup`), con la
chiave di backup del tuo account, che sta nel vault. `brain-admin backup` fa subito una copia;
`brain-admin restore` ne rimette a posto una a server fermo.

## Collegare una macchina

Su ogni tua macchina, in uno di questi modi:

- la console › **Connections** › Sign in, oppure
- `agents brain-login`.

Il token e la chiave di backup vanno direttamente nel vault. In `accounts.json` il brain è un account
di nome `brain`:

```json
{ "accounts": [{ "service": "brain", "name": "brain", "url": "https://brain.example.com" }] }
```

I profili diversi da quello predefinito raggiungono il brain come server MCP: nominali in
`servers.json` (`{ "servers": { "brain": { "_profiles": ["work"] } } }`). Vedi
[Configurazione](/it/docs/configuration/).

## Collegare Claude

Nelle app Claude e su claude.ai, nell'account che usi come predefinito: Settings › Connectors › Add
custom connector, con il nome esatto **Brain** (la console e Hey Claude cercano quel nome), e l'URL
`https://brain.example.com/mcp`. Entra nella pagina che si apre. Poi compare anche in Claude Desktop e
nell'app del telefono.
