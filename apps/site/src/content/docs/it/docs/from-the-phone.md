---
title: Dal telefono
description: Chat, task e memoria dal telefono, con le risposte delle tue macchine.
---

Il servizio serve una piccola web app su `/app`. Apri `https://<il tuo servizio>/app` sul telefono, accedi come fai
sulla pagina dell'account e aggiungila alla schermata Home: si installa come un'app. Tiene solo la sua struttura
per una connessione lenta; i tuoi dati non restano mai sul telefono per l'uso offline.

## Cosa c'è

Una barra di schede sotto il pollice, un aspetto chiaro e uno scuro (quello del dispositivo, o la tua scelta in
**Altro**), e su uno schermo largo l'elenco delle chat accanto alla conversazione.

- **Chat**: le conversazioni per giorno, con la macchina che ha risposto. I tuoi messaggi sono piccoli fumetti; le
  risposte sono testo a tutta larghezza con elenchi, link e blocchi di codice che puoi copiare; le modifiche fatte da
  Claude (una task creata, una pagina cambiata) stanno sotto la risposta come piccole etichette, e un cursore mostra
  che sta ancora scrivendo. Se nessuna macchina prende un messaggio puoi toccare _Non aspettare_; se fallisce,
  _Riprova_. Sotto il campo vedi quale macchina risponderà, e puoi cambiarla per i messaggi successivi. Su un computer
  Invio manda e Maiusc+Invio va a capo; sul telefono Invio va a capo e la freccia manda.
- **In attesa**: quello che gli agenti sulle tue macchine ti chiedono (un permesso, una domanda) e i job proposti.
  Ognuno si risponde con una passkey: _Sì_, _Sì, per la sessione_, _No_. Il numero sulla scheda conta quello che
  aspetta.
- **Task**: oggi con gli orari, quello che è in ritardo, quello che hai fatto oggi. Un tocco sul cerchio segna la
  task come fatta.
- **Brain**: cerca nella memoria per parole o per significato, sfoglia le pagine cambiate di recente e leggi una
  pagina. I link tra le pagine aprono la pagina a cui rimandano.
- **Altro**: **Macchine** (stato, carico e account di ogni nodo, quale risponde, e il collegamento di una nuova),
  le notifiche su questo dispositivo, le passkey, il tema, la lingua, la pagina dell'account ed esci.

## Di' sì con una passkey

La prima volta che apri **In attesa**, l'app ti propone di creare una passkey sul telefono: impronta o volto
confermano ogni risposta, e le tue macchine la controllano da sole. Una passkey nuova è _in attesa_: vale solo
quando un desktop con il tuo vault l'ha avallata. Sul desktop lancia `agents passkeys` (o apri _Connessioni ›
Passkey_ nella console) e approvala. Fino ad allora i pulsanti restano spenti e non è permesso nulla. Perso il
telefono? Revoca la sua passkey in **Altro** e, su un desktop, lancia `agents passkeys revoke <id>` (o _Revoca_ nella
console): scrive la revoca nel tuo vault, così le tue macchine la rifiutano anche se il servizio la elenca ancora.

## Collega una macchina

In **Altro › Macchine**, _Collega una macchina_ prende il codice di 8 caratteri che `agents node pair` mostra sulla
macchina. Il codice vale una volta e per dieci minuti; cinque codici sbagliati di fila bloccano il collegamento per
quindici minuti.

## Chi risponde

Il servizio non esegue Claude. Una chat scritta dal telefono aspetta nel tuo account finché una delle tue macchine
(l'app desktop, o un nodo su un server) la prende, la esegue e rimanda la risposta man mano. Se nessuna macchina è
online, il messaggio resta in attesa e viene risposto quando una torna. Una chat non avvia mai lavoro su una
macchina da sola: tutto quello che propone (un job, una routine, qualcosa che esce dalla macchina) aspetta ancora il
tuo sì, che si dà da un desktop o dal telefono con la passkey.

## Notifiche

In **Altro**, l'interruttore _Notifiche_ chiede il permesso al browser e registra questo dispositivo sul servizio.
Ricevi una notifica quando una risposta è pronta (o un turno fallisce); un tocco apre quella chat.

Su **iPhone e iPad** una pagina web può ricevere notifiche solo dopo essere stata aggiunta alla schermata Home: in
Safari tocca Condividi, poi _Aggiungi alla schermata Home_, e apri Agents Multi da lì. Finché non lo fai, l'app lo
dice invece di offrire l'interruttore. Serve iOS 16.4 o successivo.

## Se qualcosa non va

- L'app ti porta alla pagina di accesso: la sessione è finita. Accedi di nuovo e torni all'app.
- Un messaggio resta _in attesa_: nessuna macchina dell'account è online. Guarda **Altro › Macchine**, oppure tocca _Non aspettare_ (resta in coda e avrà risposta quando una macchina torna).
- Manca l'interruttore delle notifiche: il browser le ha bloccate per il sito (consentile nelle sue impostazioni),
  oppure non può mostrare notifiche di una web app.
