---
title: Sicurezza
description: Cosa fa Agents Multi per proteggere le tue credenziali, le tue sessioni e la tua memoria.
---

Questa pagina elenca quello che fa il progetto, così come lo dicono il codice e la documentazione. Non
è una promessa su ciò che non dicono.

## Segreti e vault

- Le credenziali stanno nel **vault**, non nella configurazione: un file cifrato per segreto, AES-GCM
  con un IV nuovo a ogni scrittura e l'id della voce come dato associato, così una voce non può essere
  scambiata con un'altra senza che ce ne si accorga. I nomi dei file sono un HMAC, quindi non dicono
  nulla di ciò che contengono.
- La chiave del vault sta **nel portachiavi di ogni macchina** (Secret Service: KWallet, GNOME
  Keyring), mai su disco accanto alle voci. Una macchina nuova la riceve una volta sola dal **codice di
  recupero** mostrato alla creazione del vault; tieni quel codice fuori dalla macchina.
- Cancellare un segreto scrive una lapide invece di rimuovere il file, così una cancellazione
  sincronizzata non può perdere contro una modifica concorrente e tornare indietro.
- Un segreto non è **mai** un argomento da riga di comando, non sta mai in un file di configurazione e
  non è mai il risultato di uno strumento. `accounts.json` elenca gli account senza alcun segreto.
- I server **mascherano** ciò che restituiscono: i valori sotto nomi che sembrano segreti (password,
  token, chiavi, cookie…) e utente e password in un indirizzo vengono sostituiti prima di arrivare in una
  conversazione. Gli strumenti che riscrivono oggetti interi rifiutano un contenuto che porta la
  maschera, così una lettura mascherata non può sovrascrivere il segreto vero.

## Tenere le sessioni lontane dal vault

I permessi condivisi vietano a una sessione di Claude le strade verso la chiave: `secret-tool`,
`kwallet-query`, `security` (il Keychain di macOS), `agents vault recovery-code`, e la lettura o la
modifica della cartella del vault. Leggere i file `.env` chiede prima. Queste liste condivise di divieti
e richieste si aggiungono a ogni profilo qualunque cosa dicano le sue impostazioni, e `agents doctor`
segnala un errore quando le impostazioni costruite di un profilo ne mancano una.

Anche gli hook delle impostazioni condivise sorvegliano il vault, e altri due sorvegliano ciò che non
si può riprendere indietro:

- **Branch e release**: il push su un branch di lavoro passa; tutto ciò che arriva in produzione
  chiede prima — un branch protetto, il tag di una versione stabile, un riferimento cancellato o
  riscritto, `--no-verify`, una release stabile.
- **Comandi distruttivi**: cancellazioni estese, lavoro perso, SQL distruttivo e rimozione di volumi
  Docker chiedono prima; ciò che non si può annullare viene negato.

Lo strumento da riga di comando di un servizio riceve il suo token tramite `agents vault run`; ciò che
cancella o fa un rollback chiede un «yes» scritto su un terminale. Una sessione di Claude non ne ha uno,
quindi lì viene rifiutato e ti viene dato il comando da lanciare.

## Cosa possono fare gli strumenti sui servizi esterni

- I server degli strumenti **non hanno strumenti di cancellazione** sui servizi esterni. L'unica
  eccezione è la cancellazione di un evento del calendario (`calendar_delete`), che chiede prima.
- Le letture (elenchi, log, stato) girano senza domande; le scritture che arrivano in produzione
  (deploy, variabili, SQL, merge) chiedono prima; le cancellazioni sono negate. Anche inviare una mail
  chiede prima.

## Il brain

- Gli account esistono solo su invito. Per entrare servono l'account, una passphrase (salvata come
  hash PBKDF2) e un codice TOTP; ripetuti tentativi sbagliati chiudono l'account a quell'indirizzo per un po'.
- Claude si collega con **OAuth 2.1 e PKCE**; le macchine ottengono un token personale dopo l'accesso.
- I token sono salvati come hash. I segreti TOTP e le chiavi di backup sono cifrati con una chiave che
  esiste solo nell'ambiente del server.
- Ogni copia del brain è **cifrata** con la tua chiave di backup prima di lasciare il server.
- I moduli agiscono solo dalle pagine del brain, il corpo delle richieste ha un limite, e gli errori
  rispondono con un identificativo, mai con il loro messaggio.

Altro in [Il brain](/it/docs/brain/) e nel
[README](https://github.com/artysan-code/agents-multi/tree/release/apps/brain#readme) del brain.

## Il sì dal telefono

Il telefono non ha fiducia cieca sulle tue macchine: una sessione web rubata o un servizio manomesso non devono poter
avviare o fermare un agente. Quello che il telefono può dire è firmato con una **passkey**, e le tue macchine lo
controllano da sole.

- Una passkey vale solo quando un desktop con il tuo vault l'ha **avallata**, confrontandone l'impronta con quella
  del telefono. Il servizio ne può registrare una ma non farla mai valere.
- La risposta firmata lega **le parole stesse della richiesta**: un hash di ciò che l'agente ha chiesto di fare. La
  macchina ricalcola quell'hash dalla propria copia della richiesta, mai da ciò che rimanda il servizio, quindi se
  le parole che il servizio ti ha mostrato differiscono da quelle vere la firma non regge.
- Accettare un job e **rifiutarlo** dal telefono si firma allo stesso modo; un rifiuto che non regge viene scartato
  dalla macchina, che te lo dice e ripropone il lavoro.
- Le risposte scadono in pochi minuti, valgono una volta e sono legate a una macchina. Il primo formato del testo
  firmato è rifiutato.
- **Revocare** una passkey (`agents passkeys revoke <id>`, o _Revoca_ nella console) scrive la revoca nel tuo
  vault, che ha ogni tua macchina: quelle rifiutano la passkey qualunque cosa elenchi il servizio. Una macchina
  senza vault si affida al servizio che la toglie.

Altro in [Dal telefono](/it/docs/from-the-phone/) e nell'
[ADR 0014](https://github.com/artysan-code/agents-multi/blob/release/docs/adr/0014-from-the-phone.md).

## Aggiornamenti

- L'app desktop si aggiorna con l'**updater firmato** di Tauri: una nuova versione viene verificata con
  la chiave di firma del progetto, e la firma porta la versione, così un manifest manomesso non può
  abbinare una versione al file di un'altra release. Vedi
  [ADR 0004](https://github.com/artysan-code/agents-multi/blob/release/docs/adr/0004-desktop-app-releases.md).
- Claude Desktop arriva dal repository apt di Anthropic, la cui chiave è **fissata**: la firma di
  `InRelease`, l'hash dell'indice e l'hash del pacchetto vengono verificati prima di estrarre un file.

## Telemetria

Nessuna. Agents Multi non invia al progetto nulla su di te o su come lo usi. Le uniche richieste che fa
sono quelle che puoi vedere: gli aggiornamenti, e il tuo brain e i tuoi servizi.

## Segnalare una vulnerabilità

Segnalala in privato tramite GitHub:
[Report a vulnerability](https://github.com/artysan-code/agents-multi/security/advisories/new). Per
favore non aprire una issue pubblica. Altro in
[SECURITY.md](https://github.com/artysan-code/agents-multi/blob/release/SECURITY.md).
