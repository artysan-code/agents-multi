---
title: Introduzione
description: Cos'è Agents Multi e che cosa mette insieme.
---

Agents Multi fa girare più account di **Claude Code** (l'agente da riga di
comando di Anthropic) e di **Claude Desktop** sulla stessa macchina Linux, senza
che si vedano tra loro, e dà a ogni Claude la stessa memoria, le stesse task e
gli stessi strumenti.

Nasce dall'uso di tutti i giorni: un account personale e un paio di account di
lavoro, ognuno con il suo login, le sue impostazioni e il suo Claude Desktop,
tutti con una memoria e una lista di task in comune, e nessuno autorizzato a
toccare i segreti.

## Cosa c'è dentro

- **Profili** — una cartella per account: login, impostazioni, skill, agenti e
  comandi, più un Claude Desktop tutto suo, con la sua icona. Vedi
  [Profili](/it/docs/profiles/).
- **La console** — un'app web locale su `127.0.0.1:7331` che mostra cosa sta
  facendo ogni profilo. Vedi [La console](/it/docs/console/).
- **Il brain** (facoltativo) — memoria e task su un tuo server, raggiunto da
  ogni Claude via MCP. Vedi [Il brain](/it/docs/brain/).
- **MCP e il vault** — MCP è il modo in cui Claude chiama gli strumenti: un solo
  registro di server, un account per strumento, ogni credenziale cifrata nel
  vault. Vedi [MCP e il vault](/it/docs/mcp-and-vault/).
- **Aggiornamenti** — Claude Code, Claude Desktop e Agents Multi si aggiornano
  da soli, con verifica e possibilità di tornare indietro. Vedi
  [Aggiornamenti](/it/docs/updates/).

## Com'è fatto

L'app desktop porta con sé il codice e lo installa in `~/.agents-multi/`, il
runtime: profili, login, sessioni. Quello che è tuo — profili, account, regole,
preferenze — sta in una tua cartella, separata dal codice, che tieni allineata
tra i computer con git o Syncthing. Il codice viaggia con l'app; la cartella del
runtime non va mai in una cartella sincronizzata, perché contiene credenziali.

:::note Agents Multi è giovane: le versioni prima della 1.0 possono ancora
cambiare l'organizzazione dei file. Ogni release dice cosa è cambiato nel
[changelog](/it/docs/changelog/). :::
