---
title: Nodi
description: Il lavoro che si sposta tra le tue macchine, e parte solo con la tua firma.
---

La console di ogni macchina può essere un **nodo** del servizio, cioè del brain, che oltre alla memoria tiene
le tue macchine e i job assegnati a ciascuna. Un job può girare sulla macchina libera e continuare su un'altra
se una si spegne. Niente si sposta senza il tuo sì.

## Rendere una macchina un nodo

```bash
agents node enable
agents node
agents nodes
```

`agents node enable` scrive `config/node.json`; `agents node` mostra cosa annuncia questa macchina; `agents nodes`
mostra tutte le macchine e i job che il servizio vede.

- **Solo in uscita.** Ogni 30 secondi il nodo dice al servizio il suo carico, quante sessioni può far girare
  (in base alla memoria, o a `maxSessions`), quali account hanno il login e se ci sei tu davanti. Usa il proprio
  token di macchina (`agents brain-login`). Niente ascolta oltre `127.0.0.1`.
- **Il tuo sì si verifica sul nodo.** Un job assegnato a un nodo parte solo con la tua firma, fatta su una tua
  macchina con una chiave derivata dal vault, che il servizio non ha mai: né un token rubato né un servizio
  compromesso possono avviare un agente.

## Accettare un job

```bash
agents nodes accept <job>
agents nodes decline <job>
agents nodes propose <routine> --node <nome>
```

`accept` mostra prima il job per intero, poi lo firma su questa macchina; il nodo può eseguirlo per 24 ore. Un
job preso gira come una routine da una volta sola, con la stessa politica dei run, gli stessi limiti e lo stesso
revisore di tutte le altre.

## Riprendere altrove

Mentre un run lavora, il suo nodo pusha il branch `agent/<id>` e i suoi handoff (`refs/agents/<id>`). Un nodo
che tace per dieci minuti perde i job in corso, e per ognuno ti aspetta una proposta di ripresa su un altro nodo,
cioè un clone dello stesso remote.

## Un nodo server

Un server esegue `agents serve --headless`: nessuna pagina, ogni figlio nella sandbox Bash di Claude Code, che
se non parte blocca tutto (`agents node probe`), e solo il nodo fa push. Claude Code lì non ha bisogno di un
desktop (il suo login è un file); ne ha bisogno solo la chiave del vault, quindi `agents vault pair --file` la
tiene in un file che leggi solo tu. L'immagine del server è in `apps/node/` del repository, con i suoi passi.
