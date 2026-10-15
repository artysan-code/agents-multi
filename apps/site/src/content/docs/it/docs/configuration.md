---
title: Configurazione
description: La cartella che contiene ciò che è tuo (profili, account, regole, preferenze), separata dal codice.
---

Tutto ciò che è tuo sta in una cartella, separata dal codice. `agents init <folder>` (o la procedura
guidata del primo avvio) la crea a partire da
[`config.example/`](https://github.com/artysan-code/agents-multi/tree/release/config.example) del
repository e collega `~/.agents-multi/config` a lei. Il codice è uguale per tutti; questa cartella è la
parte che per te è diversa.

```
~/.agents-multi/config → your folder
  owner.json           id, name, language
  profiles/<name>/     profile.json, CLAUDE.md, settings.json, skills/ agents/ commands/
  settings.json        what every profile gets
  servers.json         your choices over the MCP servers
  accounts.json        the accounts those servers use (no secrets)
  rules/               your rules, imported by each profile's CLAUDE.md
  icons/<size>/        claude-desktop-<profile>.png
```

## owner.json

Chi sei: `id` (il proprietario scritto nelle tue task: sceglilo una volta e non cambiarlo), `name` e
`language` (la lingua in cui risponde Claude).

```json
{ "id": "me", "name": "Your name", "language": "English" }
```

## Profili

Ogni cartella sotto `profiles/` con un `profile.json` è un profilo ([Profili](/it/docs/profiles/)).
I campi del manifest:

| Campo | Significato |
| --- | --- |
| `description` | una riga per te |
| `command` | il nome del launcher; se manca, è `claude-<name>` |
| `alias` | un alias di shell per il launcher |
| `skills`, `agents`, `commands` | `"all"` monta la cartella condivisa, un elenco solo quelle voci (più ciò che il profilo possiede) |
| `desktopDir` | la cartella dati del Claude Desktop del profilo |
| `disableAccountMcp` | spegne i connettori e i plugin che l'organizzazione dell'account porta con sé |
| `brainScope` | per un profilo di lavoro su un account amministrato da altri: del tuo brain vede solo le task di questi progetti (prefissi di cartella separati da virgole), e nessuna pagina di memoria |

Accanto al manifest, un profilo può avere:

- `CLAUDE.md` — le sue istruzioni, che possono importare file da `rules/`.
- `settings.json` — le differenze di quel profilo rispetto agli altri.
- `skills/`, `agents/`, `commands/` — ciò che ha solo questo profilo.

## Impostazioni e server

`settings.json` e `servers.json` sono **merge patch** sopra `shared/settings.json` e
`shared/mcp/servers.json` del repository (RFC 7386): gli oggetti si fondono, tutto il resto sostituisce,
e `null` rimuove.

- `settings.json` — ciò che ottiene ogni profilo. Il `settings.json` del singolo profilo viene applicato
  sopra. Il risultato è generato nella cartella di runtime di ogni profilo; quello che Claude Code ci
  scrive durante l'uso viene riportato nel file del profilo alla rigenerazione successiva. Vedi [Profili](/it/docs/profiles/).
- `servers.json` — quali server MCP sono attivi, e per chi. I server del registro sono modelli, tutti
  spenti: uno legato a un account si accende con un account in `accounts.json`, gli altri con
  `"<server>": { "_profiles": null }` (ogni profilo) o con un elenco di nomi di profili. Anche i server
  tuoi vanno qui, `"<name>": { "command": …, "args": … }`.
- `accounts.json` — gli account che quei server usano: servizio, un nome breve, l'indirizzo e i profili
  che lo vedono (nessuno vuol dire tutti). **Nessun segreto**: vanno nel vault
  (`agents vault set <service> <account>` o console › Connections). Vedi
  [MCP e il vault](/it/docs/mcp-and-vault/).

## Regole e icone

`rules/` contiene le tue regole come file Markdown; il `CLAUDE.md` di ogni profilo importa quelle che
vuole. `icons/<size>/claude-desktop-<profile>.png` è l'icona di un profilo che ha il suo Claude Desktop.

## Tenerla allineata tra i computer

Tieni la cartella uguale su ogni tuo computer, con Syncthing o con un repository git privato. Due
modifiche in conflitto su Syncthing lasciano una copia `.sync-conflict-`, e `agents doctor` la segnala.
La procedura guidata collega una cartella che contiene già una configurazione invece di crearne una nuova.

Non mettere `~/.agents-multi` in una cartella sincronizzata: è il runtime, e contiene dei login.

## Variabili d'ambiente

Le variabili sono `AGENTS_MULTI_<NAME>`. Quelle che puoi impostare:

| Variabile | Cosa fa |
| --- | --- |
| `AGENTS_MULTI_ROOT` | dove vive il runtime (`~/.agents-multi`) |
| `AGENTS_MULTI_CONFIG` | la tua cartella di configurazione |
| `AGENTS_MULTI_PORT` | la porta della console |
| `AGENTS_MULTI_VAULT` | la cartella del vault |
| `AGENTS_MULTI_OWNER_ID`, `AGENTS_MULTI_OWNER_NAME`, `AGENTS_MULTI_LANGUAGE` | il proprietario, quando non si legge da `owner.json` |
| `AGENTS_MULTI_FETCH_TTL`, `AGENTS_MULTI_FETCH_TIMEOUT` | ogni quanto e per quanto tempo un checkout fa il fetch (modalità dev) |

L'elenco completo, che comprende anche `TASKS`, `BRAIN`, `ACCOUNTS`, `PROFILE`, `BRAIN_SCOPE`, `REPO` e
`NO_ASSISTANT_TRAILER`, è nel
[README](https://github.com/artysan-code/agents-multi/blob/release/README.md#environment-variables) del repository.
I vecchi nomi `CLAUDE_MULTI_<NAME>` non vengono più letti.
