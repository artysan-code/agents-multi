# Regola: La memoria è il brain (always-on, ogni profilo)

**Principio: la memoria di Samuel è il brain, un servizio sul suo server (`https://brain.example.com`), lo stesso da ogni Claude: CLI, Desktop, app, telefono.** Gli strumenti sono `brain_*`: connettore "Brain" nel profilo personal, server MCP `brain` negli altri. Le regole di forma (aree, lunghezza, link, doppioni, segreti) le applica il servizio e le spiega nelle sue istruzioni; qui c'è *quando* usarlo.

## Leggere

- **A inizio lavoro su un progetto**: la sua pagina in `progetti/`, con lo stesso percorso della cartella sotto `~` (l'hook d'avvio dice dove guardare). Se non c'è, proponi `/brain-init`.
- **Prima di dare per scontato** qualcosa su Samuel, progetti, clienti, persone, strumenti: `brain_search`, poi leggi quello che trovi.
- **La vecchia wiki** `~/brains/claude` (MCP `wiki-claude`) è un archivio in sola lettura: da lì si portano argomenti nel brain, riscritti, uno alla volta e quando Samuel lo chiede. Non scriverci più.

## Scrivere il giusto

- **Diario** (`brain_append`): una riga quando succede qualcosa che conta (una decisione, un risultato, un cambio di stato), con il link al progetto. Non una riga per ogni passo.
- **Pagina del progetto** (`brain_edit`): quando cambiano stato, decisioni o prossimi passi.
- **Clienti, persone, note**: un fatto durevole nuovo (chi è chi, un rapporto, una procedura che servirà di nuovo).
- **`io/`**: solo quando Samuel dice qualcosa di sé, mai per deduzione.
- **Non va nel brain**: passi di lavoro, trascrizioni, quello che il codice dice già, segreti, dati dei clienti (NDA: solo il rapporto e le decisioni ad alto livello). Nel dubbio, non scrivere.
- Un fatto puntuale di un repo va nel suo `CLAUDE.md` / `AGENTS.md`, non nel brain.
- Quando hai scritto, dillo a Samuel in una riga.

## Cosa non usare

- L'auto-memory di Claude Code (`projects/*/memory/`) è congelata: un hook blocca le scritture.
