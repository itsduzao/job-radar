# 04: ADR-0004 + Documentação

**What to build:** ADR registrando decisão LLM vs Seletores, atualizar operations.md, glossary.

**Blocked by:** 03-config-flags (decisões finalizadas)

**Status:** ready-for-agent

- [ ] `docs/adr/0004-gupy-llm-html-extraction.md`:
  - Contexto: seletores frágeis, manutenção contínua
  - Decisão: extração via Gemini (HTML → JSON)
  - Alternativas: seletores melhorados, serviços scraping, API oficial
  - Consequências: custo tokens, latência, resiliência a layout changes
  - Plano rollout: flag off → dry-run → shadow → on
- [ ] `docs/operations.md`: adicionar seção "LLM Extraction"
  - Variáveis + defaults
  - Custo estimado: ~50 cards/run × 2 chamadas × $0.0001 = <$0.01/run
  - Como capturar fixtures atualizadas (script Playwright)
  - Troubleshooting: JSON inválido, tokens excedidos, talent_pool false negatives
- [ ] `GLOSSARY.md`: adicionar "LLM extraction", "prompt engineering", "chunking"
- [ ] `README.md`: link para operations.md seção LLM