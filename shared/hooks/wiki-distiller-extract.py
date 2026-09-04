#!/usr/bin/env python3
# Estrattore+scrubber per wiki-distiller-capture.sh (APPROCCIO A, cattura).
# Legge un transcript JSONL di Claude Code, ne ricava il dialogo reale
# (no meta, no sidechain, no tool noise), scrubba i segreti, e scrive un
# file .raw.md nella coda XDG. NON usa GPU/LLM/rete.
#   argv: <transcript> <cwd> <session_id> <queue_dir>
import json, sys, re, os, datetime

if len(sys.argv) < 5:
    sys.exit(0)
transcript, cwd, session_id, queue = sys.argv[1:5]

# --- scrub deterministico (difesa in profondità: NON ci si fida del solo prompt LLM) ---
SCRUB = [
    (re.compile(r'sk-ant-[A-Za-z0-9_\-]{10,}'), '[REDACTED_ANTHROPIC_KEY]'),
    (re.compile(r'\bgh[pousr]_[A-Za-z0-9]{20,}\b'), '[REDACTED_GITHUB_TOKEN]'),
    (re.compile(r'\bAKIA[0-9A-Z]{16}\b'), '[REDACTED_AWS_KEY]'),
    (re.compile(r'-----BEGIN [^-]+ PRIVATE KEY-----.*?-----END [^-]+ PRIVATE KEY-----', re.S), '[REDACTED_PRIVATE_KEY]'),
    (re.compile(r'(?i)\bbearer\s+[A-Za-z0-9._\-]{10,}'), 'Bearer [REDACTED]'),
    (re.compile(r'\b[a-z][a-z0-9+.\-]*://[^:\s/@]+:[^@\s/]+@'), '[REDACTED_CRED_URL]@'),
    (re.compile(r'(?im)^\s*(?:export\s+)?([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD)[A-Za-z0-9_]*)\s*=\s*\S+'), r'\1=[REDACTED]'),
    (re.compile(r'(?i)\b(api[_-]?key|token|secret|password|passwd)\b["\']?\s*[:=]\s*["\']?[A-Za-z0-9._\-/+]{8,}'), r'\1=[REDACTED]'),
    (re.compile(r'\bsk-[A-Za-z0-9]{20,}\b'), '[REDACTED_KEY]'),
]
SYSREMINDER = re.compile(r'<system-reminder>.*?</system-reminder>', re.S)

def scrub(t):
    t = SYSREMINDER.sub('', t)
    for rx, repl in SCRUB:
        t = rx.sub(repl, t)
    return t

def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(b.get('text', '') for b in content
                         if isinstance(b, dict) and b.get('type') == 'text')
    return ''

turns = []
try:
    with open(transcript) as f:
        for line in f:
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get('type') not in ('user', 'assistant'):
                continue
            if o.get('isMeta') or o.get('isSidechain'):
                continue
            msg = o.get('message') or {}
            role = msg.get('role')
            if role not in ('user', 'assistant'):
                continue
            txt = text_of(msg.get('content')).strip()
            # scarta input non-conversazionali (comandi slash, tool-result puri)
            if not txt or txt.startswith('<') or txt.startswith('/'):
                continue
            turns.append((role, txt))
except Exception:
    sys.exit(0)

if not turns:
    sys.exit(0)

# budget: ultimi turni entro ~60k char (il distill girerà a num_ctx 16k)
MAX_CHARS = 60000
buf, total = [], 0
for role, txt in reversed(turns):
    block = ('UTENTE' if role == 'user' else 'CLAUDE') + ': ' + txt
    total += len(block) + 2
    buf.append(block)
    if total > MAX_CHARS:
        break
body = scrub('\n\n'.join(reversed(buf))).strip()

date = datetime.date.today().isoformat()
sid = (session_id or 'local')[-8:]
fn = os.path.join(queue, '%s-%s.raw.md' % (date, sid))
with open(fn, 'w') as f:
    f.write('---\n')
    f.write('source_cwd: %s\n' % cwd)
    f.write('session_id: %s\n' % session_id)
    f.write('captured: %s\n' % date)
    f.write('turns_total: %d\n' % len(turns))
    f.write('status: pending-distill\n')
    f.write('---\n\n')
    f.write(body + '\n')
os.chmod(fn, 0o600)
print(fn)
