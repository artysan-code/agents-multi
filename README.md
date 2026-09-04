# Claude Code multi-account setup

Documentazione del setup multi-istanza di Claude Code sulla macchina di Samuel Tagliacozzo.
Questo file è syncato via Syncthing — vale per **tutte** le macchine su cui gira Claude Code.

> **Per altre istanze Claude**: questo file descrive il sistema in cui stai girando.
> Se sei stato avviato via `claude-work` o `claude-personal`, sei dentro questo setup.
> Se vedi `Permission denied` su `~/.claude/`, è il tripwire — è voluto, leggi sotto.

---

## Perché questo setup esiste

Servono due account Anthropic distinti (work / personal) sulla stessa macchina, completamente isolati: storia, sessioni, credenziali, MCP, plugin. La cartella `~/.claude/` standard non basta — la sostituiamo con una struttura multi-profilo sotto `~/.claude-multi/`, e blocchiamo qualsiasi accesso a `~/.claude/` come tripwire.

## Layout

```
~/.claude-multi/
├── work/                    # profilo work (account Anthropic Agency)
├── personal/                # profilo personal
├── shared/                  # config condivisa (questo file vive qui)
│   ├── settings.json        # impostazioni comuni
│   ├── skills/              # skill condivise
│   ├── plugins/marketplaces/
│   ├── statusline-command.sh
│   ├── agents/  commands/  hooks/   # attualmente vuote
│   └── README.md            # ← stai leggendo questo
└── .stignore                # esclusioni Syncthing
```

Ogni profilo ha symlink verso `shared/{agents,commands,hooks,settings.json,skills}`.

**Stato per-profilo (mai shared, escluso da Syncthing)**:
`.claude.json`, `.credentials.json`, `projects/`, `sessions/`, `cache/`,
`file-history/`, `history.jsonl`, `tasks/`, `paste-cache/`, `session-env/`,
`shell-snapshots/`, `plugins/{cache,data}`.
(Nome file verificato sul Laptop il 2026-05-11; sul fisso potrebbe essere
`home-claude.json` se è rimasto su un setup precedente — verificare.)

Le memorie auto vivono in `~/.claude-multi/<profilo>/projects/<path-progetto>/memory/`
— isolate per profilo e per progetto. **Sono syncate** (i `.jsonl` no, il contenuto `.md` sì).

## Tripwire `~/.claude/`

`~/.claude/` esiste come **directory vuota con permessi `000`**. Qualsiasi tentativo
di leggere/scrivere lì fallisce con `Permission denied`. Serve a far emergere subito
qualunque tool che provi a usare il path di default invece di rispettare
`CLAUDE_CONFIG_DIR`.

**Mai** rimuovere quei permessi, mai scrivere lì, mai ricrearla con perms normali.

Esiste anche un tripwire sul binario: `~/.local/bin/claude` è uno **script di blocco**
(non un symlink al binario). Lanciato direttamente fallisce con exit 1 e messaggio
chiaro. Forza l'uso dei wrapper.

## Avvio

| Comando            | Cosa fa                                                       |
|--------------------|---------------------------------------------------------------|
| `claude-work` (`cw`) | profilo work, `CLAUDE_CONFIG_DIR=~/.claude-multi/work`     |
| `claude-personal` (`clp`) | profilo personal, `CLAUDE_CONFIG_DIR=~/.claude-multi/personal` |
| `claude` diretto   | **bloccato** — exit 1, script di blocco                       |
| `claude-bin`       | binario reale; usato dai wrapper, non lanciare a mano         |

I wrapper:
1. Settano `CLAUDE_CONFIG_DIR` al profilo giusto
2. Settano `DISABLE_AUTOUPDATER=1`
3. `exec` di `claude-bin` con gli args

> **Nota Laptop (verifica 2026-05-11)**: sul Laptop `CLAUDE_CONFIG_DIR` è
> sufficiente — claude-bin legge/scrive `$CLAUDE_CONFIG_DIR/.claude.json`
> (con il punto) e ignora `~/.claude.json`. Nessun symlink necessario.
> Versioni precedenti di questo README descrivevano un symlink temporaneo
> `~/.claude.json → home-claude.json`: era di una fase passata, oggi non
> serve. **Sul fisso potrebbe essere diverso** — verificare lo stato reale
> dei wrapper e dei file `.claude.json` per-profilo prima di assumere.

`.zshrc` setta `CLAUDE_CONFIG_DIR=~/.claude-multi/work` come fallback per qualsiasi
sub-process che invochi `claude-bin` senza passare dai wrapper.

## Aggiornamento → usa SOLO `claude-update`

`DISABLE_AUTOUPDATER=1` blocca l'auto-update in background, **non** quello richiesto a mano.

L'updater interno di Claude Code, quando viene chiamato, scarica il nuovo ELF in
`~/.local/share/claude/versions/X.Y.Z` e ricrea `~/.local/bin/claude` come symlink
alla nuova versione — bypassando il tripwire e lasciando `claude-bin` (quello che
i wrapper usano davvero) puntato alla **vecchia** versione. Risultato: i wrapper
continuano a girare la versione vecchia.

Per evitarlo c'è `~/.local/bin/claude-update`:

```bash
claude-update    # lancia l'updater + ripristina claude-bin + ripristina tripwire
```

Lo script:
1. Esegue `claude-work update` (l'updater interno fa il download)
2. Punta `~/.local/bin/claude-bin` all'ultima versione in `versions/`
3. Riscrive `~/.local/bin/claude` come script di blocco

**Mai lanciare `claude-work update` o `claude-personal update` da soli.** Usa sempre
`claude-update`. Se è successo per sbaglio: o rilanci `claude-update`, oppure a mano
`ln -sfn ~/.local/share/claude/versions/<latest> ~/.local/bin/claude-bin` e ripristini
lo script di blocco su `~/.local/bin/claude`.

## Binario e versioni

```
~/.local/bin/claude          # script di blocco (tripwire)
~/.local/bin/claude-bin      # symlink → versions/X.Y.Z (versione attiva)
~/.local/bin/claude-work     # wrapper profilo work
~/.local/bin/claude-personal # wrapper profilo personal
~/.local/bin/claude-update   # updater custom + restore symlink
~/.local/share/claude/versions/X.Y.Z   # ELF singoli, una per versione
```

Le vecchie versioni in `versions/` non vengono pulite automaticamente — ogni tanto
puoi cancellare quelle non usate (verifica con `readlink ~/.local/bin/claude-bin`
qual è quella attiva).

## Sync (Syncthing)

- Folder `claude-multi` è syncato fra le macchine
- `.stignore` esclude tutto lo state per-machine (auth, cache, sessioni, plugin data)
- **Le credenziali OAuth (`.credentials.json`) sono machine-bound**: ogni nuova
  macchina deve riautenticare entrambi i profili (`/login` da `claude-work` e
  `claude-personal`)
- Il binario `~/.local/share/claude/versions/` **non** è dentro `~/.claude-multi/`
  e quindi **non** è syncato — ogni macchina aggiorna per conto suo con `claude-update`

## Cosa NON fare mai

- ❌ Leggere o scrivere in `~/.claude/` (tripwire `000`)
- ❌ Lanciare `claude` diretto (script di blocco)
- ❌ Lanciare `claude-work update` o `claude-personal update` senza il wrapper
  `claude-update` (lascia `claude-bin` indietro)
- ❌ Ricreare `~/claude-multi/` senza il punto (era un workaround buggato di un
  path errato in vecchio statusline, ormai eliminato)
- ❌ Aggiungere un `~/.claude.json` "globale" persistente — il file deve restare
  per-profilo in `$CLAUDE_CONFIG_DIR/.claude.json`. Un `~/.claude.json` in home
  è ignorato (Laptop, 2026-05-11) ma potrebbe creare confusione su altre
  macchine o versioni; tenere la home pulita
- ❌ Modificare `.stignore` per syncare cache/credenziali/sessioni — sono
  per-macchina apposta

## Setup di una nuova macchina

1. Installa Syncthing, attiva il folder `claude-multi` → tutto il setup arriva
2. Installa Claude Code in `~/.local/share/claude/versions/<versione>/`
3. Crea i symlink: `claude-bin`, e gli script `claude`, `claude-work`,
   `claude-personal`, `claude-update` (presenti in questo repo o ricostruibili
   da questo README)
4. Crea il tripwire: `mkdir ~/.claude && chmod 500 ~/.claude`
   (dir read-only, non scrivibile → nessun profilo può scriverci per errore.
   **Non usare `chmod 000`**: il binario fa comunque `stat` su
   `~/.claude/settings*.json` anche con `CLAUDE_CONFIG_DIR` impostato, e con 000
   ottiene EACCES → schermata "Settings Error" ad ogni avvio. Con 500 ottiene
   ENOENT, che è il caso normale "nessun settings" e non genera errori. Anche
   la variante con due `settings*.json` a `{}`/400 dentro la dir va bene, ma
   non serve.)
   In alternativa: `claude-multi-finalize`, che crea lo stub e il tripwire e
   verifica i profili. È idempotente — rilancialo quando qualcosa sembra fuori
   posto e ti dice cosa non torna.
5. Aggiungi a `.zshrc`:
   ```bash
   export DISABLE_AUTOUPDATER=1
   export CLAUDE_CONFIG_DIR="$HOME/.claude-multi/work"
   alias cw=claude-work
   alias clp=claude-personal
   ```
6. Lancia `claude-work` → `/login` con account Agency
7. Lancia `claude-personal` → `/login` con account personale

## Tassonomia Agent & Command

### Struttura a 3 livelli

| Livello | Path | Scope | Meccanismo |
|---------|------|-------|------------|
| L1 Generici condivisi | `shared/agents/` e `shared/commands/` | Tutti i profili (work + personal) | Dir reale; i file qui sono visibili a ogni profilo che symlinka verso `shared/` |
| L2 Specifici di profilo | `work/agents/` e `work/commands/` | Solo profilo work | Dir reale che contiene **symlink selettivi** verso `../../shared/agents/<file>`. `personal/agents` resta symlink diretto a `shared/agents` (personal prende tutto) |
| L3 Specifici di progetto | `<progetto>/.claude/commands/` | Singolo progetto | File reali versionati nel repo; per comandi che usano stato live del progetto (DB, env) |

### Come aggiungere un nuovo agente

1. Metti il file `.md` in `shared/agents/<nome>.md` (applica il trim dei tool se dichiara Write/Edit ma è solo audit read-only).
2. Se l'agente è specifico dello stack work (TS/pnpm/Drizzle/React), crea il symlink `work/agents/<nome>.md -> ../../shared/agents/<nome>.md`.
3. Se è solo personal, salta lo step 2 (personal symlinka già tutto `shared/agents`).
4. Se NON deve comparire in personal, mettilo come **file reale** in `work/agents/` (non symlink) invece che in `shared/`.
5. Non mettere mai agenti direttamente in `personal/agents/` — è un symlink a `shared/agents`, non puoi aggiungere file lì.

### Invariante symlink

`work/skills` è l'implementazione di riferimento: dir reale con symlink selettivi. `work/agents` e `work/commands` replicano questo pattern dal 2026-06-08.

## Knowledge Base operativa (R7) — `~/brains/claude/`

Vault LLM-wiki (Karpathy) con il knowledge **cross-progetto** per lavorare con questo setup: profilo Samuel, brief per-progetto, playbook operativi, e il **catalogo di agenti/skill/plugin NON caricati**. È ciò che rende possibile il setup *lean* (~7 agenti core): invece di pre-caricare tutto, si interroga la KB.

- **Dove**: `~/brains/claude/` (fuori da `~/.claude-multi`, NON syncato come la config; è una vault Obsidian a sé, sorella di `brains/main`).
- **Come si usa**: l'hook SessionStart `kb-nudge.sh` ricorda a ogni avvio che la KB esiste e nomina il brief del progetto corrente. Interrogala con la skill `wiki-query` (vault `~/brains/claude`) o leggi `index.md`.
- **Contratto di separazione**: sta *sopra* CLAUDE.md di progetto e auto-memory (vedi `~/brains/claude/CONVENTIONS.md`). Cross-progetto qui; specifico-repo nel CLAUDE.md; fatti di sessione in auto-memory.
- **Manutenzione** (manuale, on-demand): aggiungi pagine via `/wiki-ingest` quando hai un nuovo CLAUDE.md / post-mortem / agente da catalogare; `/wiki-lint` mensile da `~/brains/claude/`.
- **Cuore lean**: `references/{ecc-agents-catalog,ecc-skills-catalog,anthropic-plugins-catalog}.md` — "quando usare cosa".
