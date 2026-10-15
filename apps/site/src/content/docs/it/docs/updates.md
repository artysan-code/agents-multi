---
title: Aggiornamenti
description: Claude Code, Claude Desktop e Agents Multi si aggiornano da soli, con verifica e possibilità di tornare indietro.
---

Tutto si aggiorna da solo in background, senza approvazioni e senza finestre:
l'app fa il giro dieci minuti dopo l'avvio e poi ogni quattro ore, e dopo il
doctor.

- **Claude Code** — installato appena esce una nuova versione; le sessioni
  aperte continuano con la versione con cui sono partite.
- **Claude Desktop** — vive nello spazio utente, senza root in nessun passaggio.
  Una nuova versione viene _preparata_ in qualsiasi momento e _applicata_ solo
  quando nessun Claude Desktop è in esecuzione; poi la variante di ogni profilo
  viene ricostruita.
- **Agents Multi** — l'app desktop: controlla una nuova versione ogni giorno e
  la scarica in background, verificandola con la chiave di firma del progetto;
  **System › Updates** la installa e riavvia l'app. Il suo codice viene
  installato quando ogni Claude è chiuso. Le beta sono un canale a parte, e il
  pacchetto Arch lo aggiorna invece pacman.
- **Da un checkout** (modalità dev) — un pull in fast-forward su un albero
  pulito, nello stesso giro; la console si riavvia se il suo codice è cambiato,
  e `install` gira solo con ogni Claude chiuso.
- **Rollback** — `agents update --rollback` (`--desktop` per Claude Desktop), o
  un pulsante nella console.
- **Catena di fornitura** — la chiave del repository apt di Anthropic è fissata:
  la firma di `InRelease`, l'hash dell'indice e l'hash del pacchetto vengono
  verificati prima di estrarre un file.
