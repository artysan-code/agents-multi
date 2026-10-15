---
title: Per iniziare
description: Scarica l'app desktop di Agents Multi, lascia che la procedura guidata la configuri e tienila aggiornata.
---

## Scarica

Ogni macchina esegue l'app desktop **Agents Multi**: porta con sé la console, il suo backend e il Deno
che li fa girare, e installa da sola tutto il resto. Per ora Linux x86_64; macOS e Windows arrivano
con la 1.x.

Ogni versione è tra le [release su GitHub](https://github.com/artysan-code/agents-multi/releases)
(le beta sono segnate come pre-release). Scegli il file per il tuo sistema:

| Sistema          | File                                  | Installazione                                              |
| ---------------- | ------------------------------------- | ---------------------------------------------------------- |
| Debian, Ubuntu   | `agents-multi_<version>_amd64.deb`    | `sudo apt install ./agents-multi_<version>_amd64.deb`      |
| Fedora, openSUSE | `agents-multi-<version>-1.x86_64.rpm` | `sudo dnf install ./agents-multi-<version>-1.x86_64.rpm` (solo versioni stabili)   |
| Arch             | il pacchetto AUR `agents-multi-bin`   | non ancora pubblicato: nel frattempo usa l'AppImage        |
| Ovunque altro    | `agents-multi_<version>_amd64.AppImage` | `chmod +x` e avvialo                                     |

Il deb e l'rpm portano WebKitGTK come dipendenza; l'AppImage lo vuole già sul sistema (`webkit2gtk-4.1`).
Metti l'AppImage dove resterà, per esempio in `~/Applications/`: gli aggiornamenti sostituiscono quel
file sul posto, e dopo il primo avvio compare nel menu delle applicazioni.

## Requisiti

- **Linux x86_64** con una sessione desktop. L'app porta il suo Deno; non c'è niente da compilare.
- **python3**, che alcuni hook usano.
- **Un portachiavi Secret Service** (KWallet, GNOME Keyring): custodisce la chiave del vault.
- **Un'area di notifica di sistema** (system tray), dove vive l'app. Su GNOME serve l'estensione AppIndicator.
- Per un profilo con **il suo Claude Desktop**: `gnupg`, `binutils`, `libarchive` (`bsdtar`) e
  `@electron/asar` (`pnpm add -g @electron/asar`).
- `~/.local/bin` nel `PATH`: l'installazione ci mette i comandi `agents` e `claude`. La maggior parte
  delle distribuzioni lo aggiunge quando la cartella esiste; apri un nuovo terminale dopo il primo avvio.

## Primo avvio

Avvia l'app. Su una macchina senza configurazione la console si apre sulla **procedura guidata del
primo avvio**, una schermata alla volta:

1. Il tuo nome e la lingua.
2. La cartella di configurazione — quello che è tuo (profili, account, regole) sta lì, fuori dall'app.
   Una cartella che ne contiene già una, sincronizzata da un altro computer, viene solo collegata.
3. I profili: uno per account Claude, ognuno con il suo comando (`claude`, `claude-work`…).
4. L'installazione, con il suo output: i comandi in `~/.local/bin`, i profili in `~/.agents-multi`, il
   runtime dei server MCP e l'avvio al login.
5. Claude Code, se la macchina non ce l'ha: lo mette a posto l'installer di Anthropic, e da quel momento
   Agents Multi lo tiene aggiornato.
6. Il vault — un archivio cifrato per le password e i token che usano i tuoi strumenti (vedi
   [MCP e il vault](/it/docs/mcp-and-vault/)). Mostra una sola volta un codice di recupero: conservalo
   in un posto sicuro, è l'unico modo per aprire il vault su un altro computer o dopo aver perso il
   portachiavi. Oppure apri il vault di un altro computer con il suo codice.
7. L'accesso di ogni profilo: un pulsante apre Claude Code su quel profilo, dove entri con il tuo
   account Claude.
8. Il tuo brain, se vuoi: un servizio di memoria che ospiti su un tuo server ([Il brain](/it/docs/brain/)).
   Saltalo per cominciare; si può aggiungere dopo.

Riprende da dove si era fermata: ogni passo è fatto quando il suo risultato è su disco. Poi controlla
il risultato da un terminale:

```bash
agents doctor
```

Il doctor verifica ogni invariante e stampa la correzione per tutto ciò che non va. I comandi che
userai ogni giorno sono in [Comandi di tutti i giorni](/it/docs/commands/).

## Aggiornamenti

L'app si aggiorna da sola: cerca una nuova versione ogni giorno e la scarica in background, e
**System › Updates** la installa e riavvia l'app e tutto ciò che fa girare (il deb chiede la tua
password). La stessa schermata aggiorna Claude Code e Claude Desktop. Una beta resta sul canale beta;
su AUR è pacman ad aggiornare il pacchetto, e l'aggiornamento interno dell'app è spento.

## Da un checkout

Un checkout git serve per lavorare su Agents Multi stesso (modalità dev: il codice gira dal checkout e
si aggiorna con `git pull`, mentre l'app — modalità app — porta e aggiorna il proprio). Servono `deno`,
`git` e `pnpm`, con ogni Claude chiuso, e

```bash
git clone https://github.com/artysan-code/agents-multi ~/.local/src/agents-multi
~/.local/src/agents-multi/bin/agents init ~/agents-multi-config --name Ann --language English
~/.local/src/agents-multi/bin/agents install
```

`install` è idempotente e reversibile: non cancella mai contenuti reali, li sposta in
`*.pre-repo-<stamp>` e te lo dice; `install --dry-run` mostra il piano.
