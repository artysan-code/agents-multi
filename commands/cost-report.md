---
description: Report costi sessioni Claude Code da costs-<profilo>.jsonl locali. Argomento opzionale: nome profilo (work|personal|...) per filtrare.
---

# Cost Report (JSONL, per-profilo)

I costi sono separati per profilo in `~/.local/share/claude-cost/costs-<profilo>.jsonl`
(il profilo deriva da `CLAUDE_CONFIG_DIR`). Il vecchio `costs.jsonl` misto, se presente,
è incluso come profilo `legacy`. Passa un nome profilo come argomento per filtrare (es. `work`).

## Check file
```bash
ls ~/.local/share/claude-cost/costs*.jsonl 2>/dev/null && echo 'OK' || echo 'Nessun dato: avvia una sessione per popolare il tracker.'
```

## Oggi / ultimi 7 giorni (con breakdown per profilo)
```bash
node -e "
const fs=require('fs'), path=require('path');
const dir=path.join(process.env.HOME,'.local/share/claude-cost');
const only=process.argv[1]||null;
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^costs.*\.jsonl$/.test(f)):[];
let rows=[];
for(const fn of files){
  const prof = fn==='costs.jsonl' ? 'legacy' : (fn.match(/^costs-(.+)\.jsonl$/)||[])[1] || 'unknown';
  for(const l of fs.readFileSync(path.join(dir,fn),'utf8').trim().split('\n').filter(Boolean)){
    try{ const r=JSON.parse(l); r.profile=r.profile||prof; rows.push(r); }catch{}
  }
}
if(only) rows=rows.filter(r=>r.profile===only);
const today=new Date().toISOString().slice(0,10);
const todayCost=rows.filter(r=>r.timestamp.startsWith(today)).reduce((a,r)=>a+r.estimated_cost_usd,0);
console.log('Filtro profilo:', only||'(tutti)');
console.log('Oggi:', todayCost.toFixed(4), 'USD');
const byProf={};
rows.filter(r=>r.timestamp.startsWith(today)).forEach(r=>{byProf[r.profile]=(byProf[r.profile]||0)+r.estimated_cost_usd;});
Object.entries(byProf).sort((a,b)=>b[1]-a[1]).forEach(([p,c])=>console.log('  ['+p+']', c.toFixed(4)));
console.log('--- ultimi 7 giorni (totale) ---');
const byDate={};
rows.forEach(r=>{const d=r.timestamp.slice(0,10); byDate[d]=(byDate[d]||0)+r.estimated_cost_usd;});
Object.entries(byDate).sort((a,b)=>b[0].localeCompare(a[0])).slice(0,7).forEach(([d,c])=>console.log(d, c.toFixed(4)));
" "$1"
```

## Per profilo (totale complessivo)
```bash
node -e "
const fs=require('fs'), path=require('path');
const dir=path.join(process.env.HOME,'.local/share/claude-cost');
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^costs.*\.jsonl$/.test(f)):[];
const byProf={};
for(const fn of files){
  const prof = fn==='costs.jsonl' ? 'legacy' : (fn.match(/^costs-(.+)\.jsonl$/)||[])[1] || 'unknown';
  for(const l of fs.readFileSync(path.join(dir,fn),'utf8').trim().split('\n').filter(Boolean)){
    try{ const r=JSON.parse(l); byProf[prof]=(byProf[prof]||0)+r.estimated_cost_usd; }catch{}
  }
}
Object.entries(byProf).sort((a,b)=>b[1]-a[1]).forEach(([p,c])=>console.log(p, c.toFixed(4)));
"
```

## Per modello
```bash
node -e "
const fs=require('fs'), path=require('path');
const dir=path.join(process.env.HOME,'.local/share/claude-cost');
const only=process.argv[1]||null;
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^costs.*\.jsonl$/.test(f)):[];
let rows=[];
for(const fn of files){
  const prof = fn==='costs.jsonl' ? 'legacy' : (fn.match(/^costs-(.+)\.jsonl$/)||[])[1] || 'unknown';
  for(const l of fs.readFileSync(path.join(dir,fn),'utf8').trim().split('\n').filter(Boolean)){
    try{ const r=JSON.parse(l); r.profile=r.profile||prof; rows.push(r); }catch{}
  }
}
if(only) rows=rows.filter(r=>r.profile===only);
const byModel={};
rows.forEach(r=>{byModel[r.model]=(byModel[r.model]||0)+r.estimated_cost_usd;});
Object.entries(byModel).sort((a,b)=>b[1]-a[1]).forEach(([m,c])=>console.log(m, c.toFixed(4)));
" "$1"
```

## Top 10 sessioni
```bash
node -e "
const fs=require('fs'), path=require('path');
const dir=path.join(process.env.HOME,'.local/share/claude-cost');
const only=process.argv[1]||null;
const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^costs.*\.jsonl$/.test(f)):[];
let rows=[];
for(const fn of files){
  const prof = fn==='costs.jsonl' ? 'legacy' : (fn.match(/^costs-(.+)\.jsonl$/)||[])[1] || 'unknown';
  for(const l of fs.readFileSync(path.join(dir,fn),'utf8').trim().split('\n').filter(Boolean)){
    try{ const r=JSON.parse(l); r.profile=r.profile||prof; rows.push(r); }catch{}
  }
}
if(only) rows=rows.filter(r=>r.profile===only);
const lastBySess={};
rows.forEach(r=>{lastBySess[r.session_id]=r;});
Object.values(lastBySess).sort((a,b)=>b.estimated_cost_usd-a.estimated_cost_usd).slice(0,10).forEach(r=>console.log(r.session_id.slice(0,16), '['+r.profile+']', r.timestamp.slice(0,10), r.estimated_cost_usd.toFixed(4)));
" "$1"
```

> Nota: i blocchi usano `node -e`. `node` non è in allowlist (rimosso in Fase 1 per sicurezza), quindi l'esecuzione chiederà conferma — è atteso per un comando manuale. Le stime usano i prezzi 4.x; il valore autorevole resta `cost.total_cost_usd` dell'harness se la statusline lo scrive.
