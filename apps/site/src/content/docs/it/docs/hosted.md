---
title: Partire da un servizio ospitato
description: Qualcuno gestisce il servizio per te: installi Agents Multi sulla tua macchina, la colleghi con un codice, parli dal telefono.
---

Quando qualcuno ospita il servizio per te (un link d'invito, da chi lo gestisce), non ti serve un server tuo. Il
servizio tiene il tuo account, la memoria, le task e le chat; **i tuoi agenti girano sulle tue macchine**, con il tuo
Claude: il servizio non ha mai un login di Claude, una chiave del tuo vault o il tuo codice.

## 1. Il tuo account

Apri il link d'invito, scegli una passphrase e imposta il codice dell'autenticatore. L'[informativa privacy](/privacy)
di quel servizio dice chi lo gestisce, dove stanno i dati e chi può vederli.

## 2. Agents Multi sulla tua macchina

Installa l'app desktop ([Per cominciare](/it/docs/getting-started)) e fai l'accesso a Claude nel profilo che vuoi
usare. Poi collega la macchina al tuo account:

```bash
agents node pair
```

Mostra un codice di otto caratteri. Sul telefono (o in un browser qualsiasi) apri `https://<il servizio>/app`, entra,
vai in **Altro › Macchine › Collega una macchina** e scrivi il codice. L'app ti mostra quale macchina lo chiede: di' sì
solo se è tua. Da lì la macchina è un nodo del tuo account e risponde alle tue chat.

## 3. Il telefono

Aggiungi la web app alla schermata Home (su iPhone: Condividi › Aggiungi alla schermata Home, poi aprila da lì),
attiva le notifiche in **Altro** e chiedi qualcosa in **Chat**. Per rispondere dal telefono a quello che chiedono i
tuoi agenti, crea una passkey in **In attesa** e approvala dal tuo desktop:

```bash
agents passkeys endorse <id>
```

Prima di dire sì confronta l'impronta con quella che mostra il telefono.

## Cosa può fare chi ospita, e cosa no

- **Può**: leggere il database del servizio (memoria, task e chat), come chiunque gestisca un server; tenere attivo o
  fermare il servizio.
- **Non può**: eseguire niente sulle tue macchine, entrare nel tuo Claude, leggere il tuo vault o dire sì al posto
  tuo: un sì vale solo con la tua passkey, approvata dal tuo desktop, e le tue macchine lo controllano da sole.

Se preferisci tenere i dati tu, gestisci il servizio su un server tuo: [Self-hosting](/it/docs/self-hosting).
