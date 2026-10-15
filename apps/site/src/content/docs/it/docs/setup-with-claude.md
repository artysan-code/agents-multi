---
title: Configurare con Claude
description: Fatti guidare da una sessione di Claude Code nella configurazione, scrivendo tu stesso ogni segreto.
---

La [procedura guidata del primo avvio](/it/docs/getting-started/) è la strada di solito più comoda. Se
preferisci parlarne, o stai configurando da un checkout, una sessione di Claude Code può fare il lavoro
insieme a te: legge la guida del progetto scritta apposta, ti chiede quello che le serve, lancia i
comandi e si ferma dove devi agire tu.

## Come

Apri Claude Code in un terminale (in una cartella qualsiasi) e incolla:

```text
Set up Agents Multi on this machine with me. Follow
https://github.com/artysan-code/agents-multi/blob/release/ONBOARDING.md step by step,
one question at a time, and stop whenever I have to do something myself.
```

La guida, [ONBOARDING.md](https://github.com/artysan-code/agents-multi/blob/release/ONBOARDING.md), è
scritta per la sessione: cosa chiederti all'inizio, i requisiti, la tua configurazione,
l'installazione, Claude Desktop, il brain e i controlli finali.

## Cosa farà e cosa no

- **Chiede prima di qualsiasi cosa difficile da annullare**, e mostra prima il piano (`agents install --dry-run`).
- **Non vede mai i tuoi segreti.** Passphrase, token, segreti TOTP e il codice di recupero del vault li
  scrivi tu, nel tuo terminale; la sessione non li chiede mai in chat.
- **Si ferma quando Claude va chiuso.** `install` gira con ogni Claude chiuso, compresa quella sessione:
  ti dà i comandi e li lanci tu. Una nuova sessione riprende da `agents doctor`.
- **Fa prima una copia.** Le impostazioni esistenti di Claude Code vengono spostate, mai cancellate.

Quando ha finito, `agents doctor` non dovrebbe mostrare errori; da lì in poi userai i
[comandi di tutti i giorni](/it/docs/commands/).
