# Regola: La memoria è la LLM-Wiki (`~/brains/claude/`)

**Principio: la memoria persistente canonica è la LLM-Wiki, NON l'auto-memory di Claude Code.**
Vale identica su **work** e **personal**, da CLI e da Desktop.

## Dove vive la memoria

- **Memoria reale = LLM-Wiki `~/brains/claude/`** (vault Obsidian, livello R7). È l'unico posto dove si scrivono fatti durevoli. Governata da `~/brains/claude/CONVENTIONS.md` (categorie, frontmatter, contratto di separazione).
- **Auto-memory legacy** (`~/.claude-multi/*/projects/*/memory/` + `MEMORY.md`): **CONGELATA / OFF**. Non scriverci nuovi fatti — è solo archivio storico. Un guard hook (`memory-legacy-guard.sh`) **blocca (deny)** ogni tentativo di scrittura: la memoria va nella wiki. Per manutenzione legittima dei file legacy, disabilita temporaneamente l'hook.

## Prima di assumere: INTERROGA la wiki

Prima di dare per scontato qualcosa su Samuel, preferenze, progetti, setup o strumenti, **interroga la wiki** (non indovinare, non pre-caricare):
- **Work e Personal (identico)**: MCP `wiki-claude` (ricerca semantica sul vault `~/brains/claude`) oppure skill `wiki-query`. Entrambi i profili hanno l'MCP sullo stesso vault; in fallback leggi `~/brains/claude/index.md`.

## Quando salvare: SCRIVI in wiki, non altrove

Se un fatto è **durevole e cross-progetto** — profilo/preferenze di Samuel, decisioni di stack, brief di progetto, playbook operativo, catalogo agenti/skill, setup/tooling — **va nella wiki**, seguendo `CONVENTIONS.md`:
- **Work e Personal (identico)**: crea/aggiorna via `/wiki-ingest` o MCP `wiki-claude` (le mutazioni passano dal guard → conferma esplicita), oppure edit diretto sotto `~/brains/claude/` con frontmatter da `CONVENTIONS.md`. Le «zone» di lavoro sono le categorie e `projects/<nome>/` del vault, **non** una separazione per profilo.
- Se invece è un fatto **puntuale e specifico di un repo** → va nel `CLAUDE.md` di quel repo, **mai** nell'auto-memory congelata.

## Paletto NDA (invariante — vale ovunque, ogni profilo)

Codice, segreti, credenziali, dati cliente **NON entrano nella wiki**: solo meta-relazione e decisioni ad alto livello. Pagine sensibili → tag `visibility/internal` o `visibility/pii`. Nel dubbio, **non scrivere**. Questo paletto ha priorità sulla regola "salva in wiki": se un fatto è salvabile solo esponendo dati cliente, non si salva.
