# claude-multi

Setup multi-profilo di **Claude Code** e **Claude Desktop** su Linux (CachyOS/KDE): due account Anthropic isolati (personal + work) sulla stessa macchina, configurazione condivisa versionata, aggiornamenti con approvazione esplicita.

**Questo repo è la fonte di verità.** `~/.claude-multi/` è runtime materializzato da `claude-multi install`; `~/.local/bin/claude*` sono symlink a `bin/`. Fra le macchine la config viaggia con **git** (remote Forgejo), non con Syncthing.

## Comandi

| Comando | Cosa fa |
|---|---|
| `claude` (`clp`) | Claude Code, profilo **personal** (default della macchina) |
| `claude-work` (`cw`) | Claude Code, profilo **work** (account Agency) |
| `claude-multi install [--dry-run]` | materializza runtime, wrapper, unit systemd, `.desktop` dal repo. Idempotente |
| `claude-multi doctor [--json]` | verifica ogni invariante e dice come sistemarla |
| `claude-multi status [--json]` | versioni, update disponibili, sync del repo, cosa è montato per profilo, istanze attive |
| `claude-multi sync [--fetch]` | allinea il repo dal remote (fetch se stantio, pull ff-only a tree pulito) |
| `claude-multi update [--cli\|--desktop\|--check]` | aggiorna Claude Code e/o Claude Desktop (vedi sotto) |
| `claude-launch <personal\|work>` | entrypoint dei `.desktop`: gate di aggiornamento, poi l'app |

`claude update` dentro un wrapper viene dirottato su `claude-multi update --cli`: l'updater nativo riscriverebbe `~/.local/bin/claude` e lascerebbe `claude-bin` indietro.

## Layout del repo

```
bin/            wrapper e script: claude, claude-work, claude-multi, claude-launch, claude-update,
                claude-update-notify, claude-update-gui, claude-desktop-update, claude-desktop-work-rebuild
bin/lib/        prelaunch.sh — sync del repo prima di ogni avvio (bash puro, mai bloccante)
cli/main.ts     la CLI claude-multi (Deno, zero dipendenze): install · doctor · status · sync · update
shared/         config condivisa fra i profili: agents, commands, hooks, skills, rules, mcp (registry),
                settings.json, statusline-command.sh, scripts, tools
profiles/       CLAUDE.md per profilo + skill solo-work (profiles/work/skills)
lib/            claude-update-gui (PySide6)
systemd/user/   claude-update-check.{service,timer}
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
- **Gate grafico**: `claude-launch` controlla le versioni (cache 6 h) e, se serve, apre `claude-update-gui` prima dell'app: checkbox indipendenti per Code e Desktop, install via `pkexec`. Il Desktop va aggiornato ad app chiusa (l'install sostituisce `/usr/lib/claude-desktop`).
- **Timer**: `claude-update-check.timer` (10 min dopo il login, poi ogni 4 h) → una notifica KDE con «Aggiorna ora». Non aggiorna nulla da sé.

## MCP

Registry unico `shared/mcp/servers.json` (campo `_profiles` per limitare un server a un profilo). `shared/scripts/mcp-sync.py` lo applica nei `.claude.json` dei profili, a Claude chiuso (`--check` per il solo diff, usato dal doctor). Gli MCP scritti in casa stanno in `shared/mcp/<nome>/` (Deno, permessi minimi, segreti letti da `~/.config/secrets/`).

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
