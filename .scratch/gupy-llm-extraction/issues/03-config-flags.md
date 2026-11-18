# 03: Config & Feature Flags

**What to build:** Variáveis de ambiente, validação, integração no `loadConfig` e `main.ts`.

**Blocked by:** None (can start immediately; runs parallel with 00)

**Status:** ready-for-agent

- [ ] `src/config.ts`:
  - `GUPY_USE_LLM_EXTRACTION` (default: `false`)
  - `GEMINI_EXTRACTION_MODEL` (default: `gemini-1.5-flash`)
  - `GEMINI_EXTRACTION_MAX_TOKENS` (default: `8000`)
  - `GEMINI_EXTRACTION_BATCH_SIZE` (default: `10`)
  - Validação: se `GUPY_USE_LLM_EXTRACTION=true` → `GEMINI_API_KEY` obrigatório
- [ ] `src/main.ts`:
  - Instanciar `GeminiExtractor` se flag ligada
  - Passar para `GupyPlaywrightScraper`
  - Log: `llm_extraction: enabled=true model=gemini-1.5-flash batch=10`
- [ ] `test/config-llm.test.ts`: validação flags + dependências
- [ ] `docs/operations.md`: documentar novas vars + custo estimado
- [ ] `npm test` + `npm run typecheck` passam