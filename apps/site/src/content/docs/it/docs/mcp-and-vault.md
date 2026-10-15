---
title: MCP e il vault
description: Un solo registro di server MCP, un account per strumento, ogni credenziale cifrata.
---

## Il registro

Un solo registro di server MCP: un catalogo di modelli, **tutti spenti** finché
non ne accendi uno — aggiungendo un account di quel servizio, o indicando i
profili che devono vederlo. I server tuoi vanno nella tua configurazione, mai
nel repository. I server che non sono nostri (Cloudflare, Supabase, Railway…)
girano uno per account, così ciascuno vede solo il proprio.

Un profilo può vedere più account dello stesso servizio; ogni strumento allora
accetta `account`, obbligatorio non appena ce n'è più di uno — mai un valore
predefinito silenzioso.

Ogni voce di server può dividere i suoi strumenti in tre elenchi, che diventano
regole di permesso in ogni profilo: **`_allow`** per le letture (elenchi, log,
stato), che girano senza domande; **`_ask`** per le scritture che arrivano in
produzione (deploy, variabili, SQL, merge); **`_deny`** per le cancellazioni.
Uno strumento che sia legge sia scrive non sta in nessuno dei tre e segue la
modalità di permesso del profilo.

## Il vault

- Gli account sono elencati senza segreti; i **segreti stanno nel vault**: un
  file per segreto, AES-GCM con un IV nuovo a ogni scrittura, con un nome
  ottenuto con un HMAC, così i nomi non dicono nulla.
- La chiave sta nel portachiavi di ogni macchina, quindi al login non si digita
  niente. Una macchina nuova si abbina con un codice di recupero.
- Un segreto non è mai un argomento da riga di comando né il risultato di uno
  strumento. I server mascherano quello che restituiscono, e i permessi
  condivisi vietano a una sessione di Claude le strade verso la chiave.
- Lo strumento da riga di comando di un servizio riceve lo stesso token:
  `agents vault run cloudflare --
  wrangler deploy`. Ciò che cancella o fa un
  rollback chiede un «yes» scritto su un terminale — una sessione di Claude non
  ne ha uno, quindi lì viene rifiutato e ti viene dato il comando da lanciare.
