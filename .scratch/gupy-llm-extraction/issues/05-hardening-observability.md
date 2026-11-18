# 05: Hardening — Validação, Retry, Custo & Observabilidade

**What to build:** Endurecer `GeminiExtractor` com validação estrita, retry corretivo, métricas de custo/tokens e logging estruturado para operação autônoma.

**Blocked by:** 01-gemini-extractor, 02-scraper-integration

**Status:** ready-for-agent

- [ ] `src/gemini-extractor.ts` (endurecer):
  - Validação estrita por campo: `id` deve casar `/^\d+$/`; `url` deve conter `/job/{id}`; `publishedDate` deve parsear (`Date.parse` !== NaN)
  - Normalização defensiva: `workplaceType`/`jobType` fora do enum → `"unknown"` (nunca descartar a vaga inteira por 1 campo)
  - Retry corretivo: até 2 tentativas; na 2ª, injeta feedback (`"A resposta anterior falhou: <motivo>. Retorne APENAS JSON array válido."`)
  - Timeout por chamada Gemini (`GEMINI_TIMEOUT_MS`, default 30000) via `AbortSignal.timeout`
  - Descartar jobs sem `id` ou `title` (inúteis para dedupe/digest) + log `dropped_invalid_job`
- [ ] Métricas/logs:
  - Por chamada: `{batchIndex, cardsIn, jobsOut, dropped, inputTokens, outputTokens, latencyMs, retryCount}`
  - Por run: `{totalBatches, totalJobs, totalTokens, estimatedCostUsd, fallbackUsed}`
  - Custo estimado calculado por constantes de preço do modelo (configurável)
- [ ] `test/gemini-extractor-hardening.test.ts`:
  - Campo inválido isolado → normaliza/descarta, não derruba lote
  - JSON inválido 1ª vez → retry corretivo → sucesso
  - Timeout → `HttpError`/erro tratado, lote marcado como falho
  - Métricas agregadas corretas
- [ ] `npm test` + `npm run typecheck` passam