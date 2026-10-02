# Regola: Task e debrief (always-on, ogni profilo)

**Principio: le task di Samuel stanno in un posto solo, il brain, e ogni chat le tiene aggiornate.** Si usano con gli strumenti `tasks_*`: l'MCP `tasks` di ogni profilo legge e scrive nel brain, e il connettore Brain (personal, telefono) ha gli stessi strumenti sulla stessa lista; se li vedi tutti e due, sono la stessa cosa. Nei profili di lavoro (Acme, Agency) l'MCP `tasks` vede e scrive solo le task dei progetti di lavoro (`work/acme/…`): una task personale detta lì non si aggiunge, va detta in una sessione personale. Lo scopo primario: ricordargli cosa deve fare in quel giorno e a che ora.

## Quando usarlo

- **Debrief** («debrief», «cosa ho oggi/domani», «com'è la giornata», e simili) → `tasks_brief`; se c'è il server `google`, aggiungi gli eventi del calendario. Leggilo breve: prima gli orari, poi il resto, e dillo chiaramente se c'è qualcosa in ritardo.
- **Qualcosa da fare detto di passaggio** («devo…», «ricordami…», «entro venerdì…», «domani alle 10 chiamo…») → `tasks_add`, e una riga per dire cosa hai aggiunto (giorno e ora risolti: «domani» diventa la data vera, dal campo `today` delle risposte). Metti un'ora solo se l'ha data lui.
- **Fatto** («fatto», «l'ho mandata», o un lavoro che hai finito tu per una task) → `tasks_done`. Una task ricorrente crea da sola la prossima.
- **Rimandato o delegato** → `tasks_update` (nuovo giorno; `owner` a chi deve muoversi, `status: waiting` se si aspetta qualcun altro). Mai cancellare: una task che non serve più è `dropped`.
- **Task di progetto**: al posto di un `TASKS.md` nuovo, usa `tasks` con `project`. Il progetto è la cartella sotto `~` quando c'è (`work/acme/site`, `personal/dnd/dragons-lair`): la bacheca raggruppa per cartelle. I `TASKS.md` esistenti restano finché Samuel non chiede di migrarli.
- **Lavoro su una task** (Samuel la vede su una bacheca Kanban): quando si comincia → `status: doing`; se ha più passi → `tasks_steps` per scriverli e spuntarli man mano (danno la percentuale); link, file e cartelle utili → `tasks_attach`. Le note sono Markdown: leggile con `tasks_get` prima di riscriverle.

## Cosa non fare

- Non aggiungere task per ogni passo del lavoro in corso: una task è una cosa che Samuel deve ricordarsi o che resta aperta oltre la sessione.
- Non chiedere conferma per aggiungere o chiudere una task: basta dire in una riga cosa hai fatto (si corregge con una parola).
- Niente segreti o dati sensibili dei clienti nelle note: basta il riferimento («fattura settembre Acme»), non gli importi o i dati personali.
