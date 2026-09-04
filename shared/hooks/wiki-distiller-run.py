#!/usr/bin/env python3
# Distillazione LLM della coda cattura (APPROCCIO A, parte "distilla"). USA GPU.
# Da lanciare a GPU libera (on-demand) o via job idle. Per ogni file in coda:
#   guard-GPU -> Ollama (qwen3:14b, thinking off, keep_alive 0) -> nota pulita
#   nel vault _raw/sessions/ (status needs-review) -> archivia il raw in done/.
# Niente auto-promote: il distillato resta da rivedere (governance inbox).
import json, os, sys, glob, time, datetime, urllib.request, re

QUEUE = os.path.expanduser('~/.local/share/claude-distill-queue')
DONE  = os.path.join(QUEUE, 'done')
OUT   = os.environ.get('WIKI_DISTILL_OUT', os.path.expanduser('~/brains/claude/_raw/sessions'))
MODEL = os.environ.get('WIKI_DISTILL_MODEL', 'qwen3:14b')
OLLAMA = 'http://127.0.0.1:11434/api/generate'
MIN_FREE_GIB = float(os.environ.get('WIKI_DISTILL_MIN_FREE_GIB', '12'))
FORCE = os.environ.get('WIKI_DISTILL_FORCE') == '1'

def gpu_free_gib():
    best = None
    for tot in glob.glob('/sys/class/drm/card*/device/mem_info_vram_total'):
        try:
            t = int(open(tot).read())
        except Exception:
            continue
        if t < 8 * 1024**3:           # salta iGPU / carve-out piccoli
            continue
        try:
            u = int(open(tot.replace('_total', '_used')).read())
        except Exception:
            u = 0
        free = (t - u) / 1024**3
        best = free if best is None or free > best else best
    return best

PROMPT = """Sei un archivista della conoscenza. Ti do il transcript (gia ripulito dai segreti) di una sessione tra Samuel e l'assistente Claude. Estrai SOLO conoscenza durevole, in ITALIANO, come markdown conciso a bullet. Usa queste sezioni solo se hanno contenuto reale:
- **Decisioni** — scelte definitive prese
- **Fatti/Scoperte** — cose vere apprese (hardware, config, vincoli)
- **Preferenze** — su come Samuel vuole lavorare
- **Aperto** — TODO o cose ancora da decidere

Regole ferree: niente convenevoli/chiacchiera/passi intermedi; non inventare nulla; se un dato e incerto, NON riportarlo; nessun preambolo, rispondi col solo markdown.

TRANSCRIPT:
---
%s
---"""

def distill(text):
    body = json.dumps({
        'model': MODEL, 'prompt': PROMPT % text, 'stream': False,
        'think': False, 'keep_alive': 0,
        'options': {'temperature': 0.2, 'num_ctx': 16384, 'num_gpu': 999},
    }).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=600)).get('response', '').strip()

def fmget(fm, k):
    m = re.search(r'(?m)^%s:\s*(.*)$' % re.escape(k), fm)
    return m.group(1).strip() if m else ''

def main():
    files = sorted(glob.glob(os.path.join(QUEUE, '*.raw.md')))
    if not files:
        print('coda vuota'); return
    # lock anti-doppio-drain (SessionStart concorrenti); ruba un lock stantio >10 min
    lock = os.path.join(QUEUE, '.distill.lock')
    try:
        if os.path.exists(lock) and (time.time() - os.path.getmtime(lock)) > 600:
            os.unlink(lock)
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
    except FileExistsError:
        print('altro distill in corso, esco'); return
    try:
        _run(files)
    finally:
        try: os.unlink(lock)
        except OSError: pass

def _run(files):
    free = gpu_free_gib()
    if free is None:
        print('GPU dGPU non rilevata via sysfs; procedo (Ollama deciderà offload).')
    elif free < MIN_FREE_GIB and not FORCE:
        print('GPU occupata: %.1f GiB liberi < %.0f richiesti -> RINVIO. '
              'WIKI_DISTILL_FORCE=1 per forzare.' % (free, MIN_FREE_GIB))
        return
    else:
        print('GPU ok: %.1f GiB liberi.' % free)
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(DONE, exist_ok=True)
    today = datetime.date.today().isoformat()
    for fn in files:
        raw = open(fn).read()
        m = re.match(r'^---\n.*?\n---\n', raw, re.S)
        fm = m.group(0) if m else ''
        body = (raw[len(fm):] if fm else raw).strip()
        t0 = time.time()
        try:
            summary = distill(body)
        except Exception as e:
            print('ERRORE distill %s: %s' % (os.path.basename(fn), e)); continue
        if not summary:
            print('vuoto, salto %s' % os.path.basename(fn)); continue
        dt = time.time() - t0
        base = os.path.basename(fn).replace('.raw.md', '')
        outfn = os.path.join(OUT, base + '.md')
        with open(outfn, 'w') as f:
            f.write('---\n')
            f.write('title: Sessione %s\n' % base)
            f.write('category: journal\n')
            f.write('tags: [session, distilled]\n')
            f.write('summary: Digest auto-distillato (%s, locale) della sessione %s; da rivedere e promuovere.\n' % (MODEL, base))
            f.write('source_cwd: %s\n' % fmget(fm, 'source_cwd'))
            f.write('session_id: %s\n' % fmget(fm, 'session_id'))
            f.write('distilled_by: %s\n' % MODEL)
            f.write('lifecycle: draft\n')
            f.write('status: needs-review\n')
            f.write('created: %s\n' % (fmget(fm, 'captured') or today))
            f.write('updated: %s\n' % today)
            f.write('---\n\n')
            f.write(summary + '\n')
        os.rename(fn, os.path.join(DONE, os.path.basename(fn)))
        print('OK %s -> %s  (%.1fs)' % (os.path.basename(fn), outfn, dt))

if __name__ == '__main__':
    main()
