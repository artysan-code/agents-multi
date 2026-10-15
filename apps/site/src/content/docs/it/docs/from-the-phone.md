---
title: Dal telefono
description: Chat, task e memoria dal telefono, con le risposte delle tue macchine.
---

Il servizio serve una piccola web app su `/app`. Apri `https://<il tuo servizio>/app` sul telefono, accedi come fai
sulla pagina dell'account e aggiungila alla schermata Home: si installa come un'app. Tiene solo la sua struttura
per una connessione lenta; i tuoi dati non restano mai sul telefono per l'uso offline.

## Cosa c'è

- **Chat**: le conversazioni per giorno, una conversazione con la risposta che compare mentre viene scritta e le
  modifiche fatte da Claude (una task creata, una pagina cambiata), e il campo per scrivere.
- **Task**: oggi con gli orari, quello che è in ritardo, quello che hai fatto oggi. Un tocco sul cerchio segna la
  task come fatta.
- **Brain**: cerca nella memoria per parole o per significato e leggi una pagina. I link tra le pagine aprono la
  pagina a cui rimandano.
- **Macchine**: le macchine collegate al tuo account, quali sono online e quale risponde alla chat. Se è offline,
  subentra la prima online nell'ordine che hai scelto, e la risposta dice dove è stata eseguita.
- **Impostazioni**: le notifiche su questo dispositivo, la pagina dell'account, esci.

## Chi risponde

Il servizio non esegue Claude. Una chat scritta dal telefono aspetta nel tuo account finché una delle tue macchine
(l'app desktop, o un nodo su un server) la prende, la esegue e rimanda la risposta man mano. Se nessuna macchina è
online, il messaggio resta in attesa e viene risposto quando una torna. Una chat non avvia mai lavoro su una
macchina da sola: tutto quello che propone (un job, una routine, qualcosa che esce dalla macchina) aspetta ancora il
tuo sì, che per ora si dà da un desktop.

## Notifiche

In **Impostazioni**, _Attiva le notifiche_ chiede il permesso al browser e registra questo dispositivo sul servizio.
Ricevi una notifica quando una risposta è pronta (o un turno fallisce); un tocco apre quella chat.

Su **iPhone e iPad** una pagina web può ricevere notifiche solo dopo essere stata aggiunta alla schermata Home: in
Safari tocca Condividi, poi _Aggiungi alla schermata Home_, e apri Agents Multi da lì. Finché non lo fai, l'app lo
dice invece di offrire l'interruttore. Serve iOS 16.4 o successivo.

## Se qualcosa non va

- L'app ti porta alla pagina di accesso: la sessione è finita. Accedi di nuovo e torni all'app.
- Un messaggio resta _in attesa_: nessuna macchina dell'account è online. Guarda **Macchine**.
- Manca il pulsante _Attiva le notifiche_: il browser le ha bloccate per il sito (consentile nelle sue impostazioni),
  oppure non può mostrare notifiche di una web app.
