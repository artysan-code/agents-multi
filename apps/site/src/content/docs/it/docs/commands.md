---
title: Comandi di tutti i giorni
description: I comandi di Agents Multi che userai ogni giorno, e dove trovare gli altri.
---

Quasi tutto in Agents Multi avviene nell'app desktop e nella sua console: la
procedura guidata del primo avvio, gli aggiornamenti (**System › Updates**), le
connessioni, le task e il brain. Questi sono i comandi per il terminale.

## Claude, su un profilo

| Comando            | Cosa fa                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `claude`           | Claude Code sul profilo predefinito, quello il cui comando è semplicemente `claude` ([Profili](/it/docs/profiles/)) |
| `claude-<profile>` | Claude Code su un altro profilo: ogni profilo dichiara il suo comando nel proprio `profile.json`                    |

Claude Desktop si avvia dalla voce di ogni profilo nel menu delle applicazioni,
o dal selettore di profilo dell'app: l'icona nel tray apre una finestra che
chiede quale profilo avviare.

## Controllare e riparare

| Comando                    | Cosa fa                                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `agents doctor`            | verifica ogni invariante della configurazione e stampa la correzione per ciò che non va                               |
| `agents status`            | versioni, aggiornamenti disponibili, cosa ha montato ogni profilo, cosa è in esecuzione                               |
| `agents install --dry-run` | mostra cosa cambierebbe un'installazione; senza `--dry-run` la esegue (idempotente, non cancella mai contenuti reali) |
| `agents mcp sync`          | ricostruisce la configurazione di avvio MCP di ogni profilo e i server di Desktop; non serve chiudere nessun Claude   |
| `agents init <folder>`     | crea la tua cartella di configurazione, quando non usi la procedura guidata                                           |
| `agents serve`             | esegue la console senza l'app, su una macchina senza schermo                                                          |

## Aggiornamenti

| Comando                    | Cosa fa                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `agents update`            | aggiorna Claude Code, Claude Desktop e Agents Multi (fa lo stesso **System › Updates** della console) |
| `agents update --check`    | dice solo cosa c'è di nuovo                                                                           |
| `agents update --rollback` | torna al Claude Code precedente (`--desktop`: al Claude Desktop precedente)                           |

## Segreti, task e consumi

| Comando                                | Cosa fa                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `agents vault status`                  | il vault dei segreti da cui i server MCP leggono le credenziali                                  |
| `agents vault set <service> <account>` | salva il segreto di un account (oppure usa Connections nella console)                            |
| `agents brain-login`                   | fa entrare questa macchina nel tuo brain (oppure Sign in, in Connections nella console)          |
| `agents tasks brief`                   | le task di oggi dal terminale                                                                    |
| `agents usage --since 7d`              | token e una stima a prezzo di listino per profilo, modello, progetto, skill… (non è una fattura) |

L'elenco completo, con tutte le opzioni, è nel
[README](https://github.com/artysan-code/agents-multi#commands) del repository.
