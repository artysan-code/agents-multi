---
title: La console
description: Un'app web locale che mostra cosa sta facendo ogni profilo.
---

L'app desktop esegue la console, quindi finché l'app è aperta la trovi su
<http://127.0.0.1:7331>; la sua finestra la mostra. Su una macchina senza
schermo `agents serve` la esegue da sola.

La console è privata: a ogni richiesta, tranne il controllo che sia viva, chiede
un token casuale, creato a ogni avvio e tenuto in un file leggibile solo da te.
La finestra dell'app e il browser che `agents serve` apre entrano con quel token
una volta sola; a un browser che non ce l'ha viene detto da dove entrare.

Gli aggiornamenti sono **spinti, non richiesti a intervalli**: il server tiene
d'occhio le trascrizioni, la configurazione condivisa, gli agenti e le chat, e
la pagina ridisegna la vista che stai guardando. È fatta con Preact e
TypeScript, compilata una volta con la release e portata dall'app (da un
checkout la compili con pnpm sulla macchina); non si carica nulla da fuori,
quindi funziona anche su una macchina che non è mai stata online. Inglese o
italiano, secondo la lingua del computer.

## Sezioni

Tre viste in una barra a sinistra, e **Altro** per il resto: le icone si aprono
in nomi quando il puntatore ci passa sopra. In fondo, la salute della macchina
(verde, gialla o rossa; apre la pagina Salute), l'aggiornamento quando ce n'è
uno in attesa, i comandi e le preferenze.

- **Chat** — parlare con Claude come in Claude Desktop: le tue chat per giorno,
  le risposte che arrivano man mano, e sotto ogni risposta le modifiche che
  Claude ha fatto (una task, un evento, una pagina del brain). Legge task,
  calendario, posta, Drive e brain, tiene aggiornate le task e il brain da
  quello che scrivi, e non manda mai posta né cancella. Una chat può continuare
  in un terminale; il lavoro sui file di un progetto apre Claude Code in quella
  cartella. In una finestra stretta l'elenco delle chat si chiude in un
  pulsante.
- **Lavori** — le sessioni di Claude Code aperte, con quanto contesto usa
  ciascuna; gli agenti e i workflow avviati dall'hub; le ultime sessioni per
  cartella, ognuna da riaprire con un clic.
- **Account e limiti** — gli account di ogni profilo, Claude e Codex, con i loro
  limiti d'uso (le cinque ore e la settimana), quanto è vecchia ogni lettura —
  scaduta oltre la mezz'ora — e i token di oggi.
- **Altro** — Task (oggi con i suoi orari per primo, le scadute segnate, poi le
  task aperte per progetto; segnarne una come fatta è l'unica modifica che si fa
  da lì), Brain (cercarci e leggere una pagina, solo lettura), ognuna con un
  link alla bacheca web del brain; Connessioni (ogni server MCP, quali profili
  lo vedono, gli account e il vault), e profili, permessi, aggiornamenti, e ogni
  controllo del doctor con la sua correzione.

`Ctrl-K` apre una tavolozza dei comandi con ogni vista e ogni azione.

I limiti arrivano dalla riga di stato di Claude Code mentre una sessione lavora
e dai log di Codex; «Chiedi i limiti adesso» li chiede subito ad Anthropic, con
il login di ciascun profilo, che la console legge solo per quella richiesta.
Aggiungere task e scrivere nel brain si fa in una chat o sulla bacheca del
brain.

## L'app desktop

L'app nel tray fa della console un'applicazione: una finestra con la sua icona,
un puntino nel tray che diventa rosso solo quando un controllo fallisce, un
selettore di profilo e **Hey Claude** — un campo fluttuante che interroga il
profilo predefinito e mostra la risposta mentre arriva; la conversazione compare
anche in Chat.
