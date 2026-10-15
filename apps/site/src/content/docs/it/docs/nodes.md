---
title: Nodi
description: Il lavoro che si sposta tra le tue macchine, e parte solo con la tua firma.
---

La console di ogni macchina può essere un **nodo** del servizio, cioè del brain,
che oltre alla memoria tiene le tue macchine e i job assegnati a ciascuna. Un
job può girare sulla macchina libera e continuare su un'altra se una si spegne.
Niente si sposta senza il tuo sì.

## Rendere una macchina un nodo

```bash
agents node pair
agents node
agents nodes
```

`agents node pair` collega questa macchina con un codice (qui sotto) e la
accende; `agents node` mostra cosa annuncia questa macchina; `agents nodes`
mostra tutte le macchine e i job che il servizio vede. (`agents node
enable`
accende solo questa macchina, un file suo, mai sincronizzato.)

## Collegare con un codice

Sulla macchina non serve un browser, quindi funziona su un server e dal
telefono:

1. Sulla macchina lancia `agents node pair`. Chiede un codice al servizio, lo
   mostra grande (`XXXX-XXXX`) e aspetta. Il codice vale dieci minuti e un solo
   uso. Nella console è il bottone _Collega con un codice_ in Connessioni.
2. Nella web app apri _Macchine_ e scrivi il codice sotto _Collega una
   macchina_.
3. La macchina riceve il suo token al prossimo controllo, lo tiene in un file
   solo suo e accende il nodo.

Cinque codici sbagliati di fila bloccano il collegamento di quell'account per un
quarto d'ora. `agents node
login`, che fa l'accesso dal browser, resta per gli
script.

- **Solo in uscita.** Ogni 30 secondi il nodo dice al servizio il suo carico,
  quante sessioni può far girare (in base alla memoria, o a `maxSessions`),
  quali account hanno il login e se ci sei tu davanti. Usa il proprio token di
  macchina (fatto con il collegamento, e resta solo su quella macchina). Niente
  ascolta oltre `127.0.0.1`.
- **Il tuo sì si verifica sul nodo.** Un job assegnato a un nodo parte solo con
  la tua firma, fatta su una tua macchina con una chiave derivata dal vault, che
  il servizio non ha mai: né un token rubato né un servizio compromesso possono
  avviare un agente.
- **Il sì del telefono è una passkey che hai avallato.** L'app web mostra cosa
  aspetta sulle tue macchine (richieste di permesso, domande, job proposti) e
  risponde con una passkey registrata sul servizio. Una passkey conta solo dopo
  che l'hai avallata su un desktop, `agents passkeys endorse <id>`, confrontando
  la sua impronta con quella del telefono; il nodo controlla poi l'avallo, la
  firma della passkey e la scadenza prima di rispondere a qualsiasi cosa, così
  il servizio può portare la risposta ma non farla mai valere.

## Note vocali

Dal telefono puoi registrare una nota vocale (fino a cinque minuti) invece di
scrivere. Il servizio tiene l'audio solo finché il turno non finisce; una tua
macchina lo trascrive e risponde. Prende una nota vocale solo una macchina che
sa trascrivere, quindi prepara quella che risponde:

```bash
agents node voice
```

Cerca nei posti consueti il `whisper-cli` di whisper.cpp, un modello
`ggml-*.bin` multilingue (il small è il miglior compromesso su CPU) e ffmpeg, e
salva quello che trova nel `node.json` di questa macchina; `--bin` e `--model`
li indicano a mano, `--off` spegne la voce. Il nodo allora annuncia che prende
note vocali. Converte la registrazione in WAV mono a 16 kHz in una cartella
temporanea, la trascrive in locale nella lingua del tuo account, con un ambiente
vuoto (nessun segreto) e, su un server, senza rete, mostra il testo come tua
domanda e risponde. Niente viene mandato a un servizio di riconoscimento vocale.

Nell'immagine del server whisper.cpp è compilato (solo CPU, a un commit
fissato). `agents node setup` propone di scaricare un modello nel volume e ne
controlla lo SHA-256 prima di tenerlo.

## La chat della console

Quando questa macchina è un nodo, anche la Chat della console passa dal
servizio: una domanda diventa un turno assegnato a questa macchina, l'elenco
mostra le tue chat del servizio (quindi una conversazione iniziata dal telefono
è lì da continuare) e la risposta arriva in streaming come prima. Senza un
account brain, o quando il servizio non risponde, le chat restano locali.

## Accettare un job

```bash
agents nodes accept <job>
agents nodes decline <job>
agents nodes propose <routine> --node <nome>
```

`accept` mostra prima il job per intero, poi lo firma su questa macchina; il
nodo può eseguirlo per 24 ore. Un job preso gira come una routine da una volta
sola, con la stessa politica dei run, gli stessi limiti e lo stesso revisore di
tutte le altre.

## Riprendere altrove

Mentre un run lavora, il suo nodo pusha il branch `agent/<id>` e i suoi handoff
(`refs/agents/<id>`). Un nodo che tace per dieci minuti perde i job in corso, e
per ognuno ti aspetta una proposta di ripresa su un altro nodo, cioè un clone
dello stesso remote.

## Dimenticare una macchina

```bash
agents nodes forget <nome>
```

(oppure _Macchine_ nella web app) toglie il nodo, ciò che aspetta su di lui e le
sue risposte in sospeso, ridà agli altri tuoi nodi i turni che teneva e revoca i
token che portano il suo nome. Una macchina dimenticata non può tornare finché
non viene collegata di nuovo.

## Un nodo server

Un server esegue `agents serve --headless`: nessuna pagina, ogni figlio nella
sandbox Bash di Claude Code, che se non parte blocca tutto
(`agents node probe`), e solo il nodo fa push. Riceve la tua configurazione e il
vault in sola lettura, come due cartelle Syncthing a sé (`agents config move`
mette la configurazione in `~/agents-multi-config`), e lo prepara un solo
comando nel suo terminale:

```bash
agents node setup
```

Sul server nessuno fa login a Claude. Sul tuo desktop, una volta l'anno per
account:

```bash
agents node token <profilo>
```

mette nel vault un token di lunga durata di quell'account (il `setup-token` di
Claude Code); il nodo lo dà solo ai figli di quell'account, e prima di prendere
lavoro controlla che quello che eseguono non possa vederlo. Un token così fa
solo richieste al modello: niente connettori di claude.ai, i tuoi server MCP sì.
L'immagine del server è in `apps/node/` del repository, con i suoi passi.
