# 06: Rollout E2E — Dry-run com HTML Real + Shadow Mode

**What to build:** Validar ponta-a-ponta sem depender de API real em CI, e adicionar modo shadow para comparação seletores vs LLM em staging.

**Blocked by:** 04-adr-docs, 05-hardening-observability

**Status:** ready-for-agent

- [ ] Modo shadow (`GUPY_LLM_SHADOW=true`):
  - Roda extração LLM **e** seletores legados
  - Usa seletores como fonte de verdade (produção não muda)
  - Loga divergência: `{shadow: true, cardsLegacy, cardsLlm, idsOnlyLegacy, idsOnlyLlm, matched, missed}`
  - Permite comparar recall/precisão antes de virar flag ON
- [ ] Teste E2E offline (`test/gupy-llm-e2e.test.ts`):
  - Carrega `test/fixtures/gupy/job-cards-real.json` como saída mockada de `page.$$eval`
  - Mock `GeminiExtractor` retorna `extracted-jobs-real.json`
  - Roda `GupyPlaywrightScraper` completo → asserta `Post[]` com ids `gupy:{id}`, canonical urls, texto enriquecido
  - Garante **zero chamadas de rede** (assert em `fetch` mock)
- [ ] Roteiro de validação manual em staging (documentado em operations.md):
  1. `GUPY_USE_LLM_EXTRACTION=false` → baseline (seletores)
  2. `GUPY_LLM_SHADOW=true` → rodar 3x, comparar logs `shadow`
  3. `GUPY_USE_LLM_EXTRACTION=true` → rodar dry-run, revisar `Post[]`
  4. Ligar produção
- [ ] Atualizar `.env.example` em `/var/home/itsduzao/Projetos/job-radar/.env.example` com as novas flags
- [ ] `npm test` + `npm run typecheck` passam