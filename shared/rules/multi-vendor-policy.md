# Regola: Routing Modelli e Data Sovereignty

**Principio discriminante: DOVE VA IL DATO, non il costo.**

## Categorie

1. **Locale / $0 (Ollama, modelli self-hosted)** — OK ovunque: work, personal, client. Il dato non lascia la macchina.
2. **Remoto anche se gratuito (OpenRouter free, DeepSeek API, qualsiasi provider non-Anthropic)** — SOLO progetti personali. MAI su codice client, MAI su repo work.
3. **Anthropic API (Haiku/Sonnet/Opus)** — OK ovunque per default.

## DO NOT

- **OpenRouter come executor di editing**: bug streaming tool-call → `arguments={}` su Write/Edit/Bash → corruzione silenziosa dell'output. Inadatto come executor; ok solo subagent read-only in contesti personali.
- **LiteLLM versione 1.82.7 o 1.82.8**: incidente malware documentato (2025). Non installare. Non usare. Ruotare le chiavi se esposte.
- **Codice client verso API remote non-Anthropic**: proibito indipendentemente dal costo.

## Quando dubitare

Se il progetto ha un contratto cliente o dati utente, qualsiasi modello non-Anthropic deve essere locale (Ollama). In caso di dubbio, usa Anthropic.
