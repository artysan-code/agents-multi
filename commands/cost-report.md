---
description: Report costi sessioni Claude Code da costs.jsonl locale. Argomento opzionale: csv.
---

# Cost Report (JSONL)

## Check file
```bash
test -f ~/.local/share/claude-cost/costs.jsonl && echo 'OK' || echo 'Nessun dato: avvia una sessione per popolare il tracker.'
```

## Oggi / ultimi 7 giorni / per modello / per sessione (top 10)
```bash
node -e "
const fs = require('fs'), path = require('path');
const f = path.join(process.env.HOME, '.local/share/claude-cost/costs.jsonl');
const rows = fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const today = new Date().toISOString().slice(0,10);
const todayCost = rows.filter(r=>r.timestamp.startsWith(today)).reduce((a,r)=>a+r.estimated_cost_usd,0);
console.log('Oggi:', todayCost.toFixed(4), 'USD');
// last 7 days by date
const byDate = {};
rows.forEach(r=>{ const d=r.timestamp.slice(0,10); byDate[d]=(byDate[d]||0)+r.estimated_cost_usd; });
Object.entries(byDate).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,7).forEach(([d,c])=>console.log(d, c.toFixed(4)));
"
```

## Per modello
```bash
node -e "
const fs = require('fs'), path = require('path');
const f = path.join(process.env.HOME, '.local/share/claude-cost/costs.jsonl');
const rows = fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const byModel = {};
rows.forEach(r=>{ byModel[r.model]=(byModel[r.model]||0)+r.estimated_cost_usd; });
Object.entries(byModel).sort((a,b)=>b[1]-a[1]).forEach(([m,c])=>console.log(m, c.toFixed(4)));
"
```

## Top 10 sessioni
```bash
node -e "
const fs = require('fs'), path = require('path');
const f = path.join(process.env.HOME, '.local/share/claude-cost/costs.jsonl');
const rows = fs.readFileSync(f,'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));
const lastBySess = {};
rows.forEach(r=>{ lastBySess[r.session_id]=r; });
Object.values(lastBySess).sort((a,b)=>b.estimated_cost_usd-a.estimated_cost_usd).slice(0,10).forEach(r=>console.log(r.session_id.slice(0,16), r.timestamp.slice(0,10), r.estimated_cost_usd.toFixed(4)));
"
```

> Nota: i blocchi usano `node -e`. `node` non è in allowlist (rimosso in Fase 1 per sicurezza), quindi l'esecuzione chiederà conferma — è atteso per un comando manuale. Le stime usano i prezzi 4.x; il valore autorevole resta `cost.total_cost_usd` dell'harness se la statusline lo scrive.
