---
title: Profili
description: Una cartella per account Claude, scoperta dal suo manifest.
---

Un profilo è una cartella dentro `profiles/` della tua configurazione, con un
`profile.json`. Questa è l'intera definizione: in nessun punto del codice c'è un
elenco di nomi di profili, quindi aggiungerne uno vuol dire aggiungere una
cartella.

```json
{
  "description": "Research profile.",
  "command": "claude-research",
  "alias": "cr",
  "desktopDir": "~/.config/Claude-Research",
  "skills": ["graphify"],
  "agents": "all",
  "commands": "all"
}
```

- **`command`** è il nome del launcher. C'è un solo script di avvio, collegato
  una volta per profilo: capisce quale profilo avviare dal nome con cui è stato
  chiamato. Il profilo il cui comando è semplicemente `claude` è quello
  predefinito della macchina.
- **`skills`, `agents`, `commands`** — `"all"` monta l'intera cartella
  condivisa, un elenco monta solo quelle voci, più tutto ciò che il profilo
  possiede. Possedere una skill è il modo per far restare dov'è il lavoro che
  non deve passare in un altro profilo: il doctor segnala un errore se la trova
  altrove.
- **`desktopDir`** dà al profilo una build di Claude Desktop tutta sua: app id,
  icona nella barra, tooltip del tray e icone del tray colorate a parte, così
  due Desktop non si confondono mai.
- **`disableAccountMcp`** spegne i connettori e i plugin che l'organizzazione
  dell'account porta con sé.

## Impostazioni

Il `settings.json` di ogni profilo è generato: le impostazioni condivise, poi le
tue, poi quelle del profilo, unite come JSON Merge Patch. Quello che Claude ci
scrive durante l'uso viene riportato nel file del profilo alla rigenerazione
successiva, quindi non si perde nulla.
