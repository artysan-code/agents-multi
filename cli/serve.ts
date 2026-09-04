// serve.ts — dashboard locale in sola lettura: `claude-multi serve` apre http://127.0.0.1:7331.
// Un solo processo, nessun daemon: parte, apre il browser, muore con Ctrl-C. Nessuna scrittura,
// nessuna azione: i comandi di fix si copiano dal pannello Doctor. Dati = status() e usage.ts.

import { ANSI, readJson, readText, REPO, CACHE } from "./lib.ts";
import { status } from "./status.ts";
import { type GroupBy, ingest, openDb, report } from "./usage.ts";

export const PORT = Number(Deno.env.get("CLAUDE_MULTI_PORT") ?? 7331);

const HTML = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>claude-multi</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--fg:#e6e6e6;--mute:#8b93a5;--ok:#3fb950;--warn:#d29922;--fail:#f85149;--acc:#79b8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:18px;align-items:baseline;padding:14px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg)}
header h1{font-size:16px;margin:0}header .m{color:var(--mute);font-size:12px}nav{display:flex;gap:4px;margin-left:auto}
nav button{background:none;border:1px solid var(--line);color:var(--fg);padding:5px 12px;border-radius:6px;cursor:pointer}nav button.on{background:var(--panel);border-color:var(--acc)}
main{padding:18px 22px;display:grid;gap:14px}section{display:none}section.on{display:grid;gap:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}.card h3{margin:0 0 8px;font-size:13px;color:var(--mute);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.big{font-size:22px;font-weight:600}.mute{color:var(--mute)}.ok{color:var(--ok)}.warn{color:var(--warn)}.fail{color:var(--fail)}.acc{color:var(--acc)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--mute);font-weight:500}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
code{background:#0b0d11;border:1px solid var(--line);padding:1px 6px;border-radius:4px;font-size:12px}.chip{display:inline-block;padding:1px 8px;border:1px solid var(--line);border-radius:999px;font-size:12px;margin:2px 3px 2px 0}
.chip.own{border-color:var(--acc)}.chip.broken{border-color:var(--fail);color:var(--fail)}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
select{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 8px}.fix{cursor:pointer}.fix:hover{border-color:var(--acc)}
</style></head><body>
<header><h1>claude-multi</h1><span class="m" id="host"></span><span class="m" id="gen"></span>
<nav><button data-t="overview" class="on">Overview</button><button data-t="profiles">Profili</button><button data-t="doctor">Doctor</button><button data-t="usage">Usage</button><button data-t="sync">Sync</button></nav></header>
<main>
<section id="overview" class="on"><div class="grid" id="ov"></div></section>
<section id="profiles"><div class="grid" id="pf"></div><div class="card"><h3>Condiviso</h3><div id="sh"></div></div></section>
<section id="doctor"><div class="card"><h3>Doctor <span class="mute" id="dsum"></span></h3><table id="dt"></table><p class="mute">Clic su un fix per copiarlo.</p></div></section>
<section id="usage"><div class="row"><label>per <select id="uby"><option>profile</option><option>model</option><option>project</option><option>agent</option><option>day</option><option>session</option><option>entrypoint</option></select></label>
<label>dal <select id="usince"><option>7d</option><option selected>30d</option><option>90d</option><option>all</option></select></label><label>profilo <select id="uprof"><option value="">tutti</option><option>personal</option><option>work</option></select></label><span class="mute">costo = equivalente API a listino, non fatturato</span></div><div class="card"><table id="ut"></table></div></section>
<section id="sync"><div class="grid" id="sy"></div></section>
</main>
<script>
const $=s=>document.querySelector(s);const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const fmt=n=>n==null?'—':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(0)+'k':String(n);const usd=n=>n==null?'—':'$'+n.toFixed(2);
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.toggle('on',x===b));document.querySelectorAll('section').forEach(s=>s.classList.toggle('on',s.id===b.dataset.t));if(b.dataset.t==='usage')loadUsage();});
function card(title,body,cls){return '<div class="card"><h3>'+title+'</h3><div class="'+(cls||'')+'">'+body+'</div></div>';}
async function load(){const s=await (await fetch('/api/status')).json();window.S=s;
$('#host').textContent=s.machine.hostname;$('#gen').textContent=new Date(s.generatedAt).toLocaleTimeString('it-IT');
const up=k=>s.update&&s.update[k]&&s.update[k].outdated?' <span class="warn">⬆ '+esc(s.update[k].latest)+'</span>':'';
const r=s.repo;const syncCls=!r.upstream?'fail':(r.behind&&r.ahead)?'fail':(r.behind||r.ahead||r.dirty)?'warn':'ok';
const fails=s.doctor.filter(c=>c.status==='fail').length,warns=s.doctor.filter(c=>c.status==='warn').length;
$('#ov').innerHTML=card('Claude Code','<div class="big">'+esc(s.machine.cliVersion||'?')+up('cli')+'</div><div class="mute">'+(s.machine.cliVersions||[]).length+' versioni in cache</div>')
+card('Claude Desktop','<div class="big">'+esc(s.machine.desktopVersion||'non installato')+up('desktop')+'</div><div class="mute">embedded: '+Object.entries(s.machine.embeddedCode||{}).map(([k,v])=>k+' '+v.join(', ')).join(' · ')+'</div>')
+card('Repo','<div class="big '+syncCls+'">↓'+r.behind+' ↑'+r.ahead+' ✎'+r.dirty+'</div><div class="mute">'+esc(r.branch)+' @ '+esc(r.head)+'</div>')
+card('Doctor','<div class="big '+(fails?'fail':warns?'warn':'ok')+'">'+(fails?fails+' fail':warns?warns+' warn':'tutto ok')+'</div><div class="mute">'+s.doctor.length+' controlli</div>')
+card('Istanze attive','<div>'+(s.running.cli.length?s.running.cli.map(c=>'<span class="chip">'+esc(c.profile||'?')+(c.embedded?' · desktop':' · cli')+' '+esc(c.version||'')+'</span>').join(''):'<span class="mute">nessuna sessione</span>')+'</div><div class="mute">Desktop: '+(s.running.desktop.map(d=>d.variant).join(', ')||'—')+'</div>')
+card('Condiviso',Object.keys(s.shared.agents).length+' agenti · '+Object.keys(s.shared.commands).length+' comandi · '+Object.keys(s.shared.skills).length+' skill · '+s.shared.hooks.length+' hook · '+Object.keys(s.shared.mcpRegistry).length+' MCP');
const chips=(o,kind)=>Object.entries(o).map(([n,v])=>'<span class="chip'+(v.broken?' broken':(v.link&&v.link.startsWith('/')&&!v.link.includes('/shared/')?' own':''))+'">'+esc(n)+'</span>').join('')||'<span class="mute">—</span>';
$('#pf').innerHTML=Object.entries(s.profiles).map(([p,i])=>card(p+' <span class="mute">'+esc(i.account||'')+'</span>',
'<div class="mute">manifest: skills '+esc(JSON.stringify(i.manifest.skills))+' · agents '+esc(JSON.stringify(i.manifest.agents))+' · commands '+esc(JSON.stringify(i.manifest.commands))+'</div>'
+'<p><b>Skill</b> ('+Object.keys(i.mounted.skills).length+')<br>'+chips(i.mounted.skills)+'</p><p><b>Agenti</b><br>'+chips(i.mounted.agents)+'</p><p><b>Comandi</b><br>'+chips(i.mounted.commands)+'</p>'
+'<p><b>MCP cli</b> '+i.mcp.map(x=>'<span class="chip">'+esc(x)+'</span>').join('')+'<br><b>MCP desktop</b> '+(i.mcpDesktop.map(x=>'<span class="chip">'+esc(x)+'</span>').join('')||'<span class="mute">—</span>')+'</p><p><b>Plugin</b> '+i.plugins.map(x=>'<span class="chip">'+esc(x)+'</span>').join('')+'</p>')).join('');
$('#sh').innerHTML='<p><b>Registry MCP</b><br>'+Object.entries(s.shared.mcpRegistry).map(([n,v])=>'<span class="chip">'+esc(n)+' <span class="mute">'+v.profiles.join('+')+' · '+v.surfaces.join('+')+'</span></span>').join('')+'</p><p><b>Regole</b> '+s.shared.rules.map(x=>'<span class="chip">'+esc(x)+'</span>').join('')+'</p><p><b>Hook</b> '+s.shared.hooks.map(x=>'<span class="chip">'+esc(x)+'</span>').join('')+'</p><p><b>~/.agents/skills</b> '+s.shared.agentsSkills.map(x=>'<span class="chip'+(s.shared.skills[x]?'':' warn')+'">'+esc(x)+'</span>').join('')+'</p>';
const ord={fail:0,warn:1,ok:2};$('#dsum').textContent=s.doctor.filter(c=>c.status==='ok').length+' ok · '+warns+' warn · '+fails+' fail';
$('#dt').innerHTML='<tr><th></th><th>controllo</th><th>fix</th></tr>'+s.doctor.slice().sort((a,b)=>ord[a.status]-ord[b.status]).map(c=>'<tr><td class="'+c.status+'">'+({ok:'✓',warn:'!',fail:'✗'}[c.status])+'</td><td>'+esc(c.msg)+'</td><td>'+(c.fix&&c.status!=='ok'?'<code class="fix" title="copia" onclick="navigator.clipboard.writeText(this.textContent)">'+esc(c.fix)+'</code>':'')+'</td></tr>').join('');
const sy=s.sync||{};$('#sy').innerHTML=card('Repo → remote','<div>'+esc(r.remote||'nessun remote')+'</div><div class="mute">upstream '+esc(r.upstream||'—')+' · ultimo commit '+esc(r.headDate||'')+'</div>')
+card('Ultimo fetch','<div class="big">'+(sy.fetched_at?new Date(sy.fetched_at*1000).toLocaleString('it-IT'):'mai')+'</div><div class="mute">'+(sy.fetch_ok===false?'<span class="warn">ultimo fetch fallito (offline?)</span>':'ok')+' · il wrapper rifà il fetch se più vecchio di 12 h</div>')
+card('Working tree',r.dirty?'<div class="warn">'+r.dirty+' file modificati</div><div class="mute">'+esc((r.dirtyFiles||[]).join('<br>'))+'</div>':'<div class="ok">pulito</div>')
+card('Comandi','<code>claude-multi sync --fetch</code> forza il fetch<br><code>git -C ~/.local/src/claude-multi push</code> pubblica<br><code>claude-multi install</code> rimaterializza');}
async function loadUsage(){const q=new URLSearchParams({by:$('#uby').value,since:$('#usince').value,profile:$('#uprof').value});const r=await (await fetch('/api/usage?'+q)).json();
$('#ut').innerHTML='<tr><th>'+esc(r.by)+'</th><th class="n">msg</th><th class="n">sess</th><th class="n">input</th><th class="n">output</th><th class="n">cache rd</th><th class="n">cache wr</th><th class="n">costo</th></tr>'
+r.rows.map(x=>'<tr><td>'+esc(x.key)+'</td><td class="n">'+x.msgs+'</td><td class="n">'+x.sessions+'</td><td class="n">'+fmt(x.input)+'</td><td class="n">'+fmt(x.output)+'</td><td class="n">'+fmt(x.cache_read)+'</td><td class="n">'+fmt(x.cache_write)+'</td><td class="n">'+usd(x.cost)+(x.unpriced?'*':'')+'</td></tr>').join('')
+'<tr><th>totale</th><th class="n">'+(r.total.msgs||0)+'</th><th></th><th class="n">'+fmt(r.total.input)+'</th><th class="n">'+fmt(r.total.output)+'</th><th class="n">'+fmt(r.total.cache_read)+'</th><th class="n">'+fmt(r.total.cache_write)+'</th><th class="n">'+usd(r.total.cost)+'</th></tr>'
+(r.spawns.length?'<tr><td colspan="8" class="mute">subagent lanciati: '+r.spawns.map(s=>esc(s.key)+' ×'+s.n).join(' · ')+'</td></tr>':'');}
['uby','usince','uprof'].forEach(id=>$('#'+id).onchange=loadUsage);load();
</script></body></html>`;

export async function serve(opts: { open?: boolean } = { open: true }) {
  const url = `http://127.0.0.1:${PORT}`;
  let cache: { at: number; body: string } | null = null;
  const handler = async (req: Request): Promise<Response> => {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/") return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (u.pathname === "/api/status") {
        if (!cache || Date.now() - cache.at > 5000) cache = { at: Date.now(), body: JSON.stringify(await status()) };
        return new Response(cache.body, { headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/api/usage") {
        const db = openDb(); await ingest(db, { quiet: true });
        const r = report(db, { by: (u.searchParams.get("by") ?? "profile") as GroupBy, since: u.searchParams.get("since") ?? "30d", profile: u.searchParams.get("profile") || undefined, limit: 60 });
        db.close();
        return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/api/sync") return new Response(await readText(`${CACHE}/sync.json`) ?? "null", { headers: { "content-type": "application/json" } });
      return new Response("not found", { status: 404 });
    } catch (e) {
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "content-type": "application/json" } });
    }
  };
  console.log(`${ANSI.b}claude-multi serve${ANSI.x} — ${url}  ${ANSI.d}(Ctrl-C per chiudere; sola lettura, solo localhost)${ANSI.x}`);
  const srv = Deno.serve({ hostname: "127.0.0.1", port: PORT, onListen: () => {} }, handler);
  if (opts.open) { try { new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn().unref(); } catch { /* nessun browser */ } }
  await srv.finished;
}
export { readJson, REPO };
