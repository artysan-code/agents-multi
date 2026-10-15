---
title: La console
description: Un'app web locale che mostra cosa sta facendo ogni profilo.
---

L'app desktop esegue la console, quindi finché l'app è aperta la trovi su <http://127.0.0.1:7331>; la
sua finestra la mostra. Su una macchina senza schermo `agents serve` la esegue da sola.

La console è privata: a ogni richiesta, tranne il controllo che sia viva, chiede un token casuale,
creato a ogni avvio e tenuto in un file leggibile solo da te. La finestra dell'app e il browser che
`agents serve` apre entrano con quel token una volta sola; a un browser che non ce l'ha viene detto da
dove entrare.

Gli aggiornamenti sono **spinti, non richiesti a intervalli**: il server tiene d'occhio le trascrizioni
e la configurazione condivisa, chiede al brain se le sue task o le sue pagine sono cambiate, e la
pagina ridisegna la vista che stai guardando. È fatta con Preact e TypeScript, compilata una volta con
la release e portata dall'app (da un checkout la compili con pnpm sulla macchina); non si carica nulla
da fuori, quindi funziona anche su una macchina che non è mai stata online. Inglese o italiano, secondo
la lingua del computer.

## Sezioni

Una barra a sinistra contiene tutte le pagine: le icone si aprono in nomi quando il puntatore ci passa
sopra. In fondo, la salute della macchina (verde, gialla o rossa; apre la pagina Health),
l'aggiornamento quando ce n'è uno in attesa, i comandi e le preferenze.

- **Today** — la barra per chiedere a Claude; la giornata come scheda principale, con un'agenda e le
  ore lungo la scheda per gli appuntamenti e per le task con un orario (quelle in scadenza oggi senza
  orario stanno in una fascia sopra); accanto, le task come semplice elenco, e **Claude now**: i limiti
  d'uso di ogni account (le cinque ore e la settimana) con i token di oggi, e quanto contesto usa ogni
  sessione in corso, poi le ultime sessioni per cartella con il comando che riapre ciascuna.
- **Tasks** — una bacheca, un elenco ordinabile, un calendario mensile con gli eventi di Google, una
  bacheca per progetto.
- **Brain** — le pagine del brain ad albero, la ricerca per parole e per significato, ogni versione, i
  collegamenti nei due sensi, e tutto il brain come grafo in tempo reale.
- **Connections** — ogni server MCP, quali profili lo vedono, e se ciascuno l'ha montato.
- **System** — profili, permessi, plugin e skill, aggiornamenti, e ogni controllo del doctor con la sua correzione.

`Ctrl-K` apre una tavolozza dei comandi con ogni vista e ogni azione.

La barra per chiedere a Claude non ha niente da scegliere: Claude capisce se stai facendo una domanda,
dicendo una cosa da fare (diventa una task, con un orario quando si adatta alla tua giornata) o
raccontando qualcosa che vale la pena ricordare (finisce nel brain), e ogni modifica che fa compare
sotto la risposta. I limiti arrivano dalla riga di stato di Claude Code mentre una sessione lavora; il
pulsante di aggiornamento su **Claude now** li chiede subito ad Anthropic, con il login di ciascun
profilo, che la console legge solo per quella richiesta.

## L'app desktop

L'app nel tray fa della console un'applicazione: una finestra con la sua icona, un puntino nel tray
che diventa rosso solo quando un controllo fallisce, un selettore di profilo e **Hey Claude** — un campo
fluttuante che interroga il profilo predefinito e mostra la risposta mentre arriva.
