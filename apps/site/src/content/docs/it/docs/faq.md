---
title: Domande frequenti
description: Risposte brevi a quello che si chiede per prima cosa.
---

## È ufficiale?

No. Agents Multi è un progetto indipendente e non ufficiale, non affiliato né approvato da Anthropic.
Claude, Claude Code e Claude Desktop sono marchi di Anthropic, PBC.

## Costa qualcosa?

Agents Multi si usa gratis. Non ti fattura niente, e le cifre dei costi in `agents usage` e nella
console sono una stima, a prezzi di listino, di quanto costerebbero i token, non un addebito. Quello che
paghi per Claude resta tra te e Anthropic.

## Su quali sistemi gira?

Per ora Linux x86_64. macOS e Windows arrivano con la 1.x. Vedi [Per iniziare](/it/docs/getting-started/).

## Mi serve il brain?

No. È facoltativo: memoria e task su un tuo server, condivise da ogni Claude. Profili, console, MCP e
vault funzionano anche senza. Vedi [Il brain](/it/docs/brain/) e
[Ospitare il brain](/it/docs/self-hosting/).

## Invia telemetria?

No.

## Dove sono le mie credenziali?

Sulla tua macchina: il login di ogni profilo sta nella sua cartella sotto `~/.agents-multi/`, e i
segreti che usano i tuoi strumenti stanno nel vault cifrato, con la chiave nel tuo portachiavi. Non
sono mai nella tua cartella di configurazione né nel repository. Vedi [Sicurezza](/it/docs/security/).

## Posso usarlo con un solo account?

Sì. Basta un profilo; hai comunque la console, il vault, gli aggiornamenti e, se vuoi, il brain.
Aggiungere un secondo profilo più avanti vuol dire una cartella in più. Vedi [Profili](/it/docs/profiles/).

## Come funzionano gli aggiornamenti?

Claude Code, Claude Desktop e Agents Multi si aggiornano da soli in background, con verifica, e si può
tornare indietro. Vedi [Aggiornamenti](/it/docs/updates/).

## Che licenza ha?

La GNU AGPL-3.0: open source. Puoi usarlo, studiarlo, modificarlo e condividerlo, anche in
un'azienda. Chi lo distribuisce, o offre una versione modificata ad altri in rete, dà loro il codice
sorgente con la stessa licenza e mantiene la riga «Based on Agents Multi by Samuel Tagliacozzo».
Il nome e il logo non fanno parte della licenza. Vedi
[LICENSE](https://github.com/artysan-code/agents-multi/blob/release/LICENSE) e
[TRADEMARKS.md](https://github.com/artysan-code/agents-multi/blob/release/TRADEMARKS.md).

## Funziona con altri fornitori di IA?

Non ancora. Oggi è costruito attorno a Claude Code e Claude Desktop; altri fornitori sono qualcosa che
vogliamo supportare, ma non c'è una data.

## Qualcosa non va. Da dove parto?

`agents doctor`, poi [Risoluzione dei problemi](/it/docs/troubleshooting/).
