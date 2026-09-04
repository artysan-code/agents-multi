# claude-multi

Setup multi-profilo di **Claude Code** e **Claude Desktop** su Linux (CachyOS/KDE): due account Anthropic isolati (personal + work) sulla stessa macchina, configurazione condivisa versionata, aggiornamenti con approvazione esplicita.

**Questo repo è la fonte di verità.** `~/.claude-multi/` è runtime materializzato da `claude-multi install`; `~/.local/bin/claude*` sono symlink a `bin/`. Fra le macchine la config viaggia con **git** (remote Forgejo), non con Syncthing.

## Comandi

| Comando | Cosa fa |
|---|---|
| `claude` (`clp`) | Claude Code, profilo **personal** (default della macchina) |
| `claude-work` (`cw`) | Claude Code, profilo **work** (account Agency) |
| `claude-multi install [--dry-run]` | materializza runtime, wrapper, unit systemd, `.desktop` dal repo secondo i manifest dei profili. Idempotente |
| `claude-multi doctor [--json]` | verifica ogni invariante e dice come sistemarla |
| `claude-multi status [--json]` | versioni, update disponibili, sync del repo, cosa è montato per profilo, istanze attive. È il contratto JSON per statusline, gate e dashboard |
| `claude-multi sync [--fetch]` | allinea il repo dal remote (fetch se stantio, pull ff-only a tree pulito) |
| `claude-multi mcp check\|sync\|health` | registry MCP → `.claude.json` dei profili **e** `claude_desktop_config.json` delle istanze Desktop; `health` verifica binari, file e l'endpoint di embedding llama.cpp |
| `claude-multi update [--cli\|--desktop\|--check\|--rollback]` | aggiorna Claude Code e/o Claude Desktop; `--rollback` torna alla versione precedente della CLI |
| `claude-multi usage [--by …] [--since …]` | token e costo-equivalente per profilo, modello, progetto, agente, giorno (SQLite) |
| `claude-multi serve` | dashboard locale in sola lettura su `http://127.0.0.1:7331` |
| `claude-launch <personal\|work>` | entrypoint dei `.desktop`: sync del repo, gate di aggiornamento, poi l'app |

`claude update` dentro un wrapper viene dirottato su `claude-multi update --cli`: l'updater nativo riscriverebbe `~/.local/bin/claude` e lascerebbe `claude-bin` indietro.

## Profili: manifest

Ogni profilo ha `profiles/<p>/profile.json`:

```json
{ "skills": ["graphify"], "agents": "all", "commands": "all" }
```

`"all"` monta la dir condivisa intera (un symlink); una lista monta solo quelle voci, più le voci **proprie** del profilo in `profiles/<p>/<kind>/` (es. le skill cliente `clientapp-*` in `profiles/work/skills`, che così non arrivano in personal). `install` materializza, `doctor` segnala mancanti, extra e link rotti.

Le skill installate da tool esterni finiscono in `~/.agents/skills` (folder Syncthing `agents`): `install` le linka in `shared/skills` con path assoluto, e il link va committato. Le skill native del repo (`graphify`, `clientapp-*`) sono dir reali.

## Layout del repo

```
bin/            wrapper e script: claude, claude-work, claude-multi, claude-launch, claude-update,
                claude-update-notify, claude-update-gui, claude-desktop-update, claude-desktop-work-rebuild
bin/lib/        prelaunch.sh — sync del repo prima di ogni avvio (bash puro, mai bloccante)
cli/            la CLI claude-multi (Deno, zero dipendenze): main · lib · doctor · install · status · mcp · usage · serve
shared/         config condivisa fra i profili: agents, commands, hooks, skills, rules, mcp (registry),
                settings.json, statusline-command.sh, scripts, tools
profiles/       CLAUDE.md, profile.json (manifest) e voci proprie per profilo (profiles/work/skills)
lib/            claude-update-gui (PySide6)
systemd/user/   claude-update-check.{service,timer} + llama-embed.service, llama-embed-shim.service, llama-generate.service
desktop/        .desktop + icone della variante Work
pkg/            PKGBUILD del repack Arch del .deb ufficiale di Claude Desktop
```

## Layout runtime (`~/.claude-multi/`, generato da `install`)

```
shared      → <repo>/shared
marketplaces/          cloni dei marketplace plugin (per-macchina, riclonabili)
personal/   CLAUDE.md → <repo>/profiles/personal/CLAUDE.md
            settings.json agents commands hooks skills → ../shared/…
            .claude.json .credentials.json projects/ plugins/ …   ← stato per-macchina, mai nel repo
work/       come personal, ma skills/ è una dir reale con symlink selettivi
            (profiles/work/skills/* + graphify): le skill cliente non arrivano in personal
```

Isolamento: `CLAUDE_CONFIG_DIR` per profilo (binario ≥ 2.1.177, `.claude.json` per-profilo dentro la dir). `~/.claude` esiste come stub a `500` così un tool che ignora la variabile fallisce in modo visibile invece di creare un terzo profilo.

## Come si propaga fra le macchine

- Il fisso è dove si lavora e si committa. **Push mai automatico.**
- A ogni avvio di `claude`, `claude-work` o `claude-launch`, `bin/lib/prelaunch.sh`: se l'ultimo fetch ha più di 12 ore fa un `git fetch` con timeout 3 s; se il repo è indietro e il working tree è pulito fa `pull --ff-only`. Poi parte Claude, già con la config nuova: non serve riavviare. Offline o storia divergente → parte comunque e non tocca nulla.
- Lo stato finisce in `~/.cache/claude-multi/sync.json` e nella **statusline**: `cfg ↓3` indietro, `cfg ↑1` commit non pushati, `cfg ✎2` modifiche non committate, `cfg ≠` divergente, `cfg offline` fetch fallito. Accanto, `⬆ code x.y.z` / `⬆ desktop x.y.z` quando c'è un aggiornamento.
- `claude-multi sync --fetch` forza il fetch (utile sul portatile prima di iniziare).

## Aggiornamenti

Niente si aggiorna senza approvazione. `DISABLE_AUTOUPDATER=1` è impostato ovunque.

- **Claude Code**: l'updater nativo scarica l'ELF in `~/.local/share/claude/versions/X.Y.Z` e riscrive `~/.local/bin/claude`. `claude-update --cli` lo invoca, ripunta `claude-bin` all'ultima versione, ripristina il wrapper `claude`, pota le versioni vecchie, sistema l'url-handler `claude-cli://`.
- **Claude Desktop**: `claude-desktop-update` ricostruisce il pacchetto Arch dal `.deb` ufficiale Anthropic (PKGBUILD in `pkg/`), poi `claude-desktop-work-rebuild` rigenera la variante **Work** (asar con `app.setDesktopName("claude-desktop-work")` per avere icona e app_id distinti su KDE Wayland; tutto il resto è symlink a `/usr/lib/claude-desktop`).
- **Gate grafico**: `claude-launch` controlla le versioni (cache 6 h) e, se serve, apre `claude-update-gui` prima dell'app: checkbox indipendenti per Code e Desktop con le novità della versione, install via `pkexec`. Il Desktop va aggiornato ad app chiusa (l'install sostituisce `/usr/lib/claude-desktop`). La GUI è una **vista della CLI**: il pannello «Stato del setup» arriva da `claude-multi status --json` (versioni, doctor con fix copiabili, istanze), le azioni passano da `claude-multi update` e `claude-multi serve`. Dal menu, «Claude — aggiornamenti e stato» apre lo stesso pannello in modalità standalone anche senza aggiornamenti, con il rollback della CLI.
- **Timer**: `claude-update-check.timer` (10 min dopo il login, poi ogni 4 h) → una notifica KDE con «Aggiorna ora». Non aggiorna nulla da sé.

## MCP

Registry unico `shared/mcp/servers.json`. Per server: `_profiles` (default tutti) e `_surfaces` (`cli` = `.claude.json` del profilo, letto da Claude Code CLI ed embedded; `desktop` = `claude_desktop_config.json` dell'istanza Desktop, letto dalla chat). `claude-multi mcp sync` applica il registry a tutte le superfici, con merge non distruttivo, guard sulle istanze attive (`--force` per ignorarlo), backup in `~/.local/state/claude-multi/` e stato per-macchina. `mcp health` controlla binari, file, lock, vault e l'endpoint di embedding di `wiki-claude`: **non** Ollama, ma `llama-embed-shim` (`shared/tools/llama-embed-shim`, porta 11434, parla il protocollo Ollama perché obsidian-brain conosce solo quello) davanti a `llama-server` di llama.cpp (`llama-embed.service`, porta 8090, bge-m3 su Vulkan). `llama-generate.service` è on-demand: la accende lo shim per il distiller e la spegne a riposo. Gli MCP scritti in casa stanno in `shared/mcp/<nome>/` (Deno, permessi minimi, segreti letti da `~/.config/secrets/`).

## Aggiornamenti: dettagli

- Un solo `claude-update` alla volta (lock in `~/.cache/claude-update/update.lock`).
- Il prune delle versioni CLI tiene la penultima: `claude-multi update --rollback` ci torna.
- `claude-update --check --json` allega `changelog_file` con la sezione del CHANGELOG ufficiale della versione remota: il gate lo mostra prima di chiedere l'approvazione.
- Claude Desktop: la chiave pubblica del repo apt Anthropic (`https://downloads.claude.ai/claude-desktop/key.asc`, fingerprint `31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE`) è in `pkg/claude-desktop/anthropic-apt.asc`. `claude-desktop-update` verifica con `gpgv` la firma dell'`InRelease`, che sia della chiave pinnata, e lo sha256 dell'indice `Packages`; il `.deb` è poi verificato dallo sha256 preso da quell'indice. Catena completa fino al pacchetto.

## Macchina nuova

```bash
git clone ssh://git@git.example.com:2222/owner/claude-multi.git ~/.local/src/claude-multi
~/.local/src/claude-multi/bin/claude-multi install
claude        # → /login (account personale)
claude-work   # → /login (account work)
```

Serve: `deno`, `git`, `jq`, `python3`; per Claude Desktop anche `base-devel`, `libarchive`, `pyside6`, `@electron/asar`. Le credenziali OAuth sono per-macchina. Claude Code si installa la prima volta con l'installer nativo, poi `claude-multi update --cli`.

## Cosa non fare

- Non scrivere in `~/.claude/` (stub) e non cambiargli i permessi.
- Non modificare `~/.claude-multi/shared` fuori dal repo.
- Non lanciare `claude-work update` o `claude-bin update` a mano: usa `claude-multi update`.
- Non rimettere `~/.claude-multi` in Syncthing: i backup con token ci sono già finiti una volta.
- Non aggiornare Claude Desktop con l'app aperta.

## Knowledge base

Il *perché* delle scelte, i post-mortem e il catalogo di agenti/skill non caricati vivono nella LLM-wiki `~/brains/claude/` (pagine `references/claude-multi-account-setup`, `claude-desktop-integration`, `claude-update-gate`). Qui c'è solo il *come*.
