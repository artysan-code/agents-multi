---
title: Dal telefono
description: Chat, task e memoria dal telefono, con le risposte delle tue macchine.
---

Il servizio serve una piccola web app su `/app`. Apri
`https://<il tuo servizio>/app` sul telefono, accedi come fai sulla pagina
dell'account e aggiungila alla schermata Home: si installa come un'app. Tiene
solo la sua struttura per una connessione lenta; i tuoi dati non restano mai sul
telefono per l'uso offline.

## Cosa c'è

Una barra di schede sotto il pollice, un aspetto chiaro e uno scuro (quello del
dispositivo, o la tua scelta in **Altro**), e su uno schermo largo l'elenco
delle chat accanto alla conversazione. Niente scorre su una pagina se il suo
contenuto è più corto dello schermo.

**Scorri.** Trascina il dito di lato per passare da una scheda all'altra; la
pagina segue il dito e si assesta con una molla (con il movimento ridotto cambia
e basta). Su una riga lo scorrimento è una scorciatoia di un pulsante che c'è
sempre: una task a destra è _fatta_, una chat a sinistra è _elimina_ (con un
_Annulla_ per qualche secondo), una richiesta o un job a destra è _sì_ o
_accetta_, a sinistra _no_ o _rifiuta_. Il sì chiede comunque la tua passkey.

- **Chat**: le conversazioni per giorno, con la macchina che ha risposto. I tuoi
  messaggi sono piccoli fumetti; le risposte sono testo a tutta larghezza con
  elenchi, link e blocchi di codice che puoi copiare; le modifiche fatte da
  Claude (una task creata, una pagina cambiata) stanno sotto la risposta come
  piccole etichette, e un cursore mostra che sta ancora scrivendo. Una risposta
  in attesa o in corso si può _Annullare_; se fallisce o è annullata, _Riprova_.
  Puoi rinominare una chat (la matita), eliminarla, cercare nell'elenco e
  copiare una risposta. Sotto il campo vedi quale macchina risponderà, e puoi
  cambiarla per i messaggi successivi. Su un computer Invio manda e Maiusc+Invio
  va a capo; sul telefono Invio va a capo e la freccia manda.
- **Voce**: nel campo, il microfono piccolo _detta_: le parole compaiono mentre
  le dici, nella lingua dell'app (le sente il servizio vocale del telefono, di
  Apple o di Google; l'app lo dice). Il pulsante a onda registra una _nota
  vocale_: tienilo premuto e lascia per inviare, scorri via per annullare,
  oppure toccalo per una registrazione che resta aperta con _Annulla_ e _Invia_
  (al massimo cinque minuti o 10 MB). Appare come un piccolo fumetto audio
  finché una macchina non l'ha trascritta, poi come le tue parole. Può farlo
  solo una macchina con whisper.cpp e ffmpeg (`agents node voice`); se nessuna è
  online la nota resta in attesa e l'app lo dice.
- **In attesa**: quello che gli agenti sulle tue macchine ti chiedono (un
  permesso, una domanda) e i job proposti. Ognuno si risponde con una passkey:
  _Sì_, _Sì, per la sessione_, _No_. Il numero sulla scheda conta quello che
  aspetta.
- **Task**: oggi con gli orari, quello che è in ritardo, quello che hai fatto
  oggi. Le righe sono compatte: il titolo tagliato a due righe e sotto una riga
  piccola con l'ora, il progetto e quanto è in ritardo. Un tocco sul cerchio, o
  uno scorrimento a destra, segna la task come fatta.
- **Brain**: cerca nella memoria per parole o per significato, sfoglia le pagine
  cambiate di recente e leggi una pagina. I link tra le pagine aprono la pagina
  a cui rimandano.
- **Altro**: **Macchine** (stato, carico e account di ogni nodo, quale risponde,
  e il collegamento di una nuova, e _Dimentica_ per quelle che non usi più,
  offerto prima sulle offline), le notifiche su questo dispositivo, le passkey,
  il tema, la lingua, la pagina dell'account ed esci.

## Di' sì con una passkey

La prima volta che apri **In attesa**, l'app ti propone di creare una passkey
sul telefono: impronta o volto confermano ogni risposta, e le tue macchine la
controllano da sole. Una passkey nuova è _in attesa_: vale solo quando un
desktop con il tuo vault l'ha avallata. Sul desktop lancia `agents passkeys` (o
apri _Connessioni › Passkey_ nella console) e approvala. Fino ad allora i
pulsanti restano spenti e non è permesso nulla. Perso il telefono? Revoca la sua
passkey in **Altro** e, su un desktop, lancia `agents passkeys revoke <id>` (o
_Revoca_ nella console): scrive la revoca nel tuo vault, così le tue macchine la
rifiutano anche se il servizio la elenca ancora.

La passkey viene chiesta in modo che il tuo gestore di password (Bitwarden,
Portachiavi iCloud, Google) possa salvarla: è una credenziale rilevabile. Se
crearla fallisce, l'app mostra l'errore esatto del browser, nome e messaggio,
con un suggerimento: _NotAllowedError_ (annullata, o sono passati i cinque
minuti), _InvalidStateError_ (già registrata qui), _SecurityError_ (l'indirizzo
non è il dominio del servizio). Il sì che dai è legato alle parole che hai
visto: un servizio che mostrasse altre parole otterrebbe una firma che la
macchina rifiuta.

## Collega una macchina

In **Altro › Macchine**, _Collega una macchina_ prende il codice di 8 caratteri
che `agents node pair` mostra sulla macchina. Il codice vale una volta e per
dieci minuti; cinque codici sbagliati di fila bloccano il collegamento per
quindici minuti.

## Chi risponde

Il servizio non esegue Claude. Una chat scritta dal telefono aspetta nel tuo
account finché una delle tue macchine (l'app desktop, o un nodo su un server) la
prende, la esegue e rimanda la risposta man mano. Se nessuna macchina è online,
il messaggio resta in attesa e viene risposto quando una torna. Una chat non
avvia mai lavoro su una macchina da sola: tutto quello che propone (un job, una
routine, qualcosa che esce dalla macchina) aspetta ancora il tuo sì, che si dà
da un desktop o dal telefono con la passkey.

## Notifiche

In **Altro**, l'interruttore _Notifiche_ chiede il permesso al browser e
registra questo dispositivo sul servizio. Ricevi una notifica quando una
risposta è pronta (o un turno fallisce); un tocco apre quella chat.

Su **iPhone e iPad** una pagina web può ricevere notifiche solo dopo essere
stata aggiunta alla schermata Home: in Safari tocca Condividi, poi _Aggiungi
alla schermata Home_, e apri Agents Multi da lì. Finché non lo fai, l'app lo
dice invece di offrire l'interruttore. Serve iOS 16.4 o successivo.

## Se qualcosa non va

- L'app ti porta alla pagina di accesso: la sessione è finita. Accedi di nuovo e
  torni all'app.
- Un messaggio resta _in attesa_: nessuna macchina dell'account è online. Guarda
  **Altro › Macchine**, oppure _Annulla_ il messaggio.
- Manca l'interruttore delle notifiche: il browser le ha bloccate per il sito
  (consentile nelle sue impostazioni), oppure non può mostrare notifiche di una
  web app.
