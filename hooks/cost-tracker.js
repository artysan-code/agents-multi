#!/usr/bin/env node
/**
 * Cost Tracker Hook (adattato da ECC scripts/hooks/cost-tracker.js)
 *
 * Stop hook: legge transcript_path da stdin, somma i token di tutti i turni
 * assistant nel JSONL di sessione, stima il costo via rate-table e appende una
 * riga JSONL a ~/.local/share/claude-cost/costs.jsonl. Esce sempre 0.
 *
 * Adattamenti dal sorgente ECC:
 *  - rimosse le require('../lib/utils') e ('../lib/session-bridge');
 *  - inline di sanitizeSessionId / ensureDir / appendFile;
 *  - output → ~/.local/share/claude-cost/costs.jsonl (non ~/.claude, tripwire);
 *  - RATE_TABLE aggiornata ai prezzi 4.x (verificati via skill claude-api 2026-06-08).
 *
 * Comportamento cumulativo: Stop scatta per ogni risposta assistant, non per
 * sessione. Ogni riga è il totale cumulativo della sessione fino a quel punto.
 * Per il costo per-sessione: prendi l'ultima riga per session_id.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HARNESS_COST_MAX_AGE_SECONDS = 300;
const COSTS_DIR = path.join(os.homedir(), '.local/share/claude-cost');

// Profilo (work/personal/...) derivato dal basename di CLAUDE_CONFIG_DIR
// (~/.claude-multi/<profilo>). Separa i costi per profilo in file distinti
// costs-<profilo>.jsonl, evitando il merge work+personal nel report.
// Fallback 'unknown' se l'env non è impostato o ha un nome anomalo.
function detectProfile() {
  const base = path.basename(process.env.CLAUDE_CONFIG_DIR || '').replace(/[^A-Za-z0-9_-]/g, '');
  return base || 'unknown';
}
const PROFILE = detectProfile();
const COSTS_FILE = path.join(COSTS_DIR, `costs-${PROFILE}.jsonl`);

// --- helper inline (ex lib/utils + lib/session-bridge) ---
function sanitizeSessionId(id) {
  if (!id || typeof id !== 'string') return '';
  return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 128);
}
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* noop */ }
}
function appendFile(file, data) {
  try { fs.appendFileSync(file, data); } catch { /* noop */ }
}

/**
 * Legge il costo autorevole dell'harness dal cache file per-sessione (se la
 * statusline lo scrive). Null su miss / stale / parse error.
 */
function readHarnessCost(sessionId, maxAgeSeconds) {
  if (!sessionId) return null;
  try {
    const fp = path.join(os.tmpdir(), `harness-cost-${sessionId}.json`);
    if (!fs.existsSync(fp)) return null;
    const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const ts = Number(obj && obj.ts);
    const cost = Number(obj && obj.cost_usd);
    if (!Number.isFinite(ts) || !Number.isFinite(cost) || cost < 0) return null;
    const age = Math.floor(Date.now() / 1000) - ts;
    if (age < 0 || age > maxAgeSeconds) return null;
    return cost;
  } catch {
    return null;
  }
}

// Tariffe approssimate per 1M token (USD), prezzi 4.x (2026-06-08).
// Cache write (5m TTL): 1.25x input. Cache read: 0.1x input.
const RATE_TABLE = {
  haiku:  { in: 1.00, out: 5.0,  cacheWrite: 1.25, cacheRead: 0.10 },  // Haiku 4.5
  sonnet: { in: 3.00, out: 15.0, cacheWrite: 3.75, cacheRead: 0.30 },  // Sonnet 4.6
  opus:   { in: 5.00, out: 25.0, cacheWrite: 6.25, cacheRead: 0.50 }   // Opus 4.8
};

function getRates(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('haiku')) return RATE_TABLE.haiku;
  if (m.includes('opus'))  return RATE_TABLE.opus;
  return RATE_TABLE.sonnet;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function sumUsageFromTranscript(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let model = 'unknown';

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg || !msg.usage) continue;

    const u = msg.usage;
    inputTokens      += toNumber(u.input_tokens);
    outputTokens     += toNumber(u.output_tokens);
    cacheWriteTokens += toNumber(u.cache_creation_input_tokens);
    cacheReadTokens  += toNumber(u.cache_read_input_tokens);

    if (msg.model && msg.model !== 'unknown') model = msg.model;
  }

  return { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, model };
}

const MAX_STDIN = 64 * 1024;
let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
});

process.stdin.on('end', () => {
  try {
    const input = raw.trim() ? JSON.parse(raw) : {};

    const transcriptPath = (typeof input.transcript_path === 'string' && input.transcript_path)
      ? input.transcript_path
      : process.env.CLAUDE_TRANSCRIPT_PATH || null;

    const sessionId =
      sanitizeSessionId(input.session_id) ||
      sanitizeSessionId(process.env.CLAUDE_SESSION_ID) ||
      'default';

    let usageTotals = null;
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      usageTotals = sumUsageFromTranscript(transcriptPath);
    }

    const {
      inputTokens = 0,
      outputTokens = 0,
      cacheWriteTokens = 0,
      cacheReadTokens = 0,
      model = 'unknown'
    } = usageTotals || {};

    const rates = getRates(model);
    const transcriptCostUsd = Math.round((
      (inputTokens      / 1e6) * rates.in +
      (outputTokens     / 1e6) * rates.out +
      (cacheWriteTokens / 1e6) * rates.cacheWrite +
      (cacheReadTokens  / 1e6) * rates.cacheRead
    ) * 1e6) / 1e6;

    // Preferisci il costo autorevole dell'harness se la statusline l'ha scritto.
    const harnessCost = readHarnessCost(sessionId, HARNESS_COST_MAX_AGE_SECONDS);
    const estimatedCostUsd = harnessCost !== null
      ? Math.round(harnessCost * 1e6) / 1e6
      : transcriptCostUsd;

    ensureDir(path.dirname(COSTS_FILE));

    const row = {
      timestamp:          new Date().toISOString(),
      profile:            PROFILE,
      session_id:         sessionId,
      transcript_path:    transcriptPath || '',
      model,
      input_tokens:       inputTokens,
      output_tokens:      outputTokens,
      cache_write_tokens: cacheWriteTokens,
      cache_read_tokens:  cacheReadTokens,
      estimated_cost_usd: estimatedCostUsd
    };

    appendFile(COSTS_FILE, `${JSON.stringify(row)}\n`);
  } catch {
    // Non-bloccante — non far mai fallire lo Stop hook.
  }

  // Pass-through di stdin (convenzione hook ECC).
  process.stdout.write(raw);
});
