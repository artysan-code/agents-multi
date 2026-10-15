---
title: Risoluzione dei problemi
description: Parti dal doctor, poi le situazioni più comuni e cosa farci.
---

## Parti dal doctor

```bash
agents doctor
```

Verifica ogni invariante della configurazione e stampa la correzione per ciò che non va.
`agents doctor --probe` manda anche una piccola richiesta per profilo per vedere se il login di Claude
Code funziona. `agents status` mostra le versioni, cosa ha montato ogni profilo e cosa è in esecuzione.
La sezione **System** della console mostra gli stessi controlli con le loro correzioni.

## L'installazione o l'aggiornamento aspetta che Claude si chiuda

Un'installazione che cambierebbe ciò che un Claude aperto legge (le sue impostazioni, i suoi
collegamenti) aspetta che nessun Claude sia in esecuzione; una che non cambia nulla di tutto questo
prosegue subito. Il pulsante di aggiornamento nella barra laterale dice allora **Close Claude to
finish**: apre la schermata dell'aggiornamento all'ultimo passo, che elenca le sessioni da chiudere e le
chiude quando glielo dici, oppure lascia l'installazione per dopo — si completa da sola appena ogni
Claude è chiuso. Un nuovo Claude Desktop già scaricato prende la sua versione alla prossima apertura.
Claude Desktop resta nel tray quando chiudi la sua finestra: esci da lì.

## `agents` non viene trovato

L'installazione mette `agents` e `claude` in `~/.local/bin`. Controlla che sia nel `PATH` e apri un
nuovo terminale. La maggior parte delle distribuzioni lo aggiunge quando la cartella esiste.

## Il vault non si apre

La chiave del vault sta nel tuo portachiavi, quindi serve un Secret Service in esecuzione (KWallet,
GNOME Keyring) e sbloccato. Controlla con `agents vault status`.

- Portachiavi bloccato: sbloccalo (di solito si sblocca al login).
- Nessun Secret Service su questa macchina: installane e avviane uno.
- Portachiavi perso o macchina nuova: la scheda del vault in console › Connections (oppure
  `agents vault pair`) con il codice di recupero del vault. Se hai un altro computer che ha ancora il
  vault, `agents vault recovery-code` lanciato in un terminale là lo mostra. Non ripristinare la
  cartella del vault da un backup su una macchina reinstallata: abbinala e lascia che le voci si sincronizzino.

## Il login di un profilo è scaduto

Apri un terminale e avvia il comando di quel profilo, `claude-<profile>` (semplicemente `claude` per
quello predefinito), poi scrivi `/login`. `agents doctor --probe` ti dice quali profili ne hanno bisogno.

## Un server MCP non compare

```bash
agents mcp sync
agents mcp health --probe
```

`sync` ricostruisce la configurazione di avvio di ogni profilo (e i server di Desktop); `health --probe`
avvia ogni server e aspetta che risponda. Poi riavvia Claude: le istanze in esecuzione non recepiscono
le modifiche. Un server che richiede un account compare solo quando l'account esiste in `accounts.json`.

## Il brain non risponde

Controlla l'indirizzo in console › Connections. Se il token della macchina è sparito o scaduto, entra di nuovo:

```bash
agents brain-login
```

Se continua a non andare, controlla che `https://<your brain>/ready` risponda; sul tuo server, il log
del servizio dice perché (vedi [Ospitare il brain](/it/docs/self-hosting/)).

## Copie in conflitto di Syncthing

Quando due macchine cambiano lo stesso file, Syncthing lascia accanto all'originale un file con
`.sync-conflict-` nel nome, e il doctor lo segnala. Confronta le due versioni, tieni il contenuto
giusto nell'originale e cancella la copia.

## Tornare indietro dopo un aggiornamento

```bash
agents update --rollback            # the previous Claude Code
agents update --rollback --desktop  # the previous Claude Desktop
```

Gli stessi pulsanti sono in **System › Updates**.

## Dove sono i log

- Aggiornamenti: `~/.local/state/agents-multi/updates.jsonl`, una riga per risultato, mostrato in
  **System › Updates**.
- L'app desktop: `~/.local/share/me.artysan.agents/logs/`, con `backend.log` (il backend della console
  e i suoi lavori programmati) e `install.log` (l'installazione del codice).
