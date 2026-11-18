# 02: GupyPlaywrightScraper — Integração LLM + Chunking

**What to build:** Atualizar `GupyPlaywrightScraper` para usar `GeminiExtractor` em vez de seletores CSS. Manter seletores legados como fallback (feature flag).

**Blocked by:** 01-gemini-extractor, 03-config-flags (both edit `src/main.ts`; serialized to avoid merge conflicts)

**Status:** ready-for-agent

- [ ] `src/playwright-scraper.ts` (modificar `GupyPlaywrightScraper`):
  - Constructor recebe `geminiExtractor?: GeminiExtractor` + `useLLM: boolean`
  - `fetchPosts(url)`:
    - Carrega página (mesmo código atual)
    - Extrai `cardHtmls = await page.$$eval(CARD_SELECTOR, els => els.map(el => el.outerHTML))`
    - Se `useLLM && geminiExtractor`:
      - Chunk `cardHtmls` em lotes de `GEMINI_EXTRACTION_BATCH_SIZE` (env, default 10)
      - Para cada lote: `jobs = await geminiExtractor.extractJobs(chunk, url)`
      - Agrega `allJobs`
    - Senão (fallback): usa `extractJobs()` atual (seletores)
    - Mapeia `ExtractedJob[]` → `Post[]` (reutiliza `mapJobToPost` adaptado)
  - Remove lógica de paginação complexa (LLM extrai todos os cards da página atual; paginação continua igual)
  - Log estruturado: `cards_found`, `llm_calls`, `llm_success`, `llm_fallback`
- [ ] `src/main.ts`: instanciar `GeminiExtractor` e passar para `GupyPlaywrightScraper` quando `GUPY_USE_LLM_EXTRACTION=true`
- [ ] `test/playwright-scraper-llm.test.ts`:
  - Mock `page.$$eval` retorna fixture `job-cards-real.json`
  - Mock `GeminiExtractor` retorna `ExtractedJob[]`
  - Testa: chunking correto, agregação, fallback para seletores quando `useLLM=false`
- [ ] `npm test` + `npm run typecheck` passam