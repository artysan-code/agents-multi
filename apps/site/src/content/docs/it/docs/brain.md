---
title: Il brain
description: Memoria e task sul tuo server, raggiunte da ogni Claude che usi.
---

Il brain è un piccolo servizio sul tuo server. Ogni persona ha un account e un
database suoi; ogni Claude che usa si collega lì — le app Claude e claude.ai
come connettore personalizzato, Claude Code e Claude Desktop come server MCP
remoto — e così le sue macchine, con un token personale.

## Cosa conserva

- **Documenti** — Markdown con un percorso, collegati con `[[target]]` come li
  scrive Obsidian, in sette aree: chi sei, progetti, clienti, persone, note, un
  diario, una inbox.
- **Cronologia** — ogni scrittura conserva la versione che sostituisce, con chi
  l'ha fatta e quando. Qualsiasi cosa si può leggere com'era e rimettere a
  posto.
- **Task** — un documento per task, una lista per ogni chat, la console e la
  bacheca web.
- **Ricerca** — per parole e per significato, combinate; gli embedding sono
  calcolati da un modello sullo stesso server.

Claude scrive senza chiedere, quindi le regole le fa rispettare il servizio e
una scrittura che ne viola una viene rifiutata con le ragioni: un argomento per
pagina, un titolo e una frase che dice cos'è, almeno un collegamento, niente
copie quasi uguali, niente segreti.

## Chi può entrare

Gli account esistono solo su invito. In un brain che gestisci tu ne sei
l'amministratore, e inviti gli altri: come installarne uno e gestirne gli
account è nel
[README](https://github.com/artysan-code/agents-multi/tree/release/apps/brain#readme)
del brain. Per entrare servono l'account, una passphrase e un codice TOTP.
Claude si collega con OAuth 2.1 e PKCE; le macchine ottengono un token personale
dopo l'accesso. I token sono salvati come hash; i segreti TOTP e le chiavi di
backup sono cifrati con una chiave che esiste solo sul server.

## Copie di sicurezza

Le tue macchine controllano ogni mezz'ora se il brain è cambiato e scaricano una
copia solo quando è cambiato, sigillata con la tua chiave di backup. Nessun
terzo custodisce il brain.
