# CCR Staged Plan (design-only, non eseguire finché T1 non è misurato)

## Cos'è CCR
@musistudio/claude-code-router (34.8k★, MIT): proxy locale che intercetta le chiamate API di Claude Code e rerouta le richieste di subagent verso modelli alternativi basandosi sull'alias model:.

## Gate di attivazione
1. T1 tiering (model: frontmatter) misurato per ≥2 settimane.
2. Delta costo documentato in costs.jsonl e /cost-report.
3. CCR testato SOLO su un progetto personale (mai clientapp, mai ark-project client).
4. Chiave DeepSeek salvata PRIMA di abilitare.

## Install (quando gate superato)
npm install -g @musistudio/claude-code-router
Verificare che CCR non scriva su ~/.claude (tripwire 000) — controllare source su GitHub prima di installare.

## Config file
Path: ~/.config/ccr/config.json  (NON in ~/.claude-multi, NON in ~/.claude)
Modo: 600

```json
{
  "default": "claude-sonnet-4-6",
  "router": {
    "background": { "model": "deepseek-chat", "provider": "deepseek" },
    "think":      { "model": "claude-opus-4-8", "provider": "anthropic" }
  },
  "providers": {
    "deepseek": {
      "apiKey": "env:DEEPSEEK_API_KEY",
      "baseUrl": "https://api.deepseek.com"
    }
  }
}
```

## DeepSeek key storage
File: ~/.config/secrets/deepseek-api-key  (mode 600, dir mode 700)
Load: export DEEPSEEK_API_KEY=$(cat ~/.config/secrets/deepseek-api-key)
Aggiungere a ~/.zshrc solo DOPO aver abilitato CCR per progetti personali.

## Data policy
DeepSeek = provider remoto → SOLO progetti personali (vedi shared/rules/multi-vendor-policy.md).

## Rollback
unset DEEPSEEK_API_KEY  → CCR usa il fallback Anthropic automaticamente.
