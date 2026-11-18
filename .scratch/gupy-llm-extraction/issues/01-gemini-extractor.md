# 01: GeminiExtractor — Core Extraction Logic

**What to build:** `src/gemini-extractor.ts` com classe `GeminiExtractor` que recebe HTML (lote de cards) e retorna `ExtractedJob[]` validado.

**Blocked by:** 00-prompt-fixture (prompt + fixtures)

**Status:** ready-for-agent

- [ ] `src/gemini-extractor.ts`:
  - `interface ExtractedJob` (conforme spec)
  - `class GeminiExtractor { constructor(apiKey: string, model?: string, logger?) }`
  - `async extractJobs(cardHtmls: string[], sourceUrl: string): Promise<ExtractedJob[]>`
    - Monta prompt: system (lido de `src/prompts/gupy-extraction-v1.txt`) + user (HTML + URL)
    - Chama Gemini API (`generateContent`)
    - Parse JSON response
    - Valida cada job com Zod schema (ou validação manual)
    - Retry 2x se parse/validação falhar (com prompt corretivo: "Retorne APENAS JSON array válido")
    - Log: tokens input/output, latência, sucesso/falha
  - Env: `GEMINI_EXTRACTION_MODEL` (default: `gemini-1.5-flash`), `GEMINI_EXTRACTION_MAX_TOKENS` (default: 8000)
- [ ] `test/gemini-extractor.test.ts`:
  - Mock `fetch` global com resposta Gemini válida (usar fixture `extracted-jobs-real.json`)
  - Testa: parse sucesso, validação campos obrigatórios, retry em JSON inválido, fallback talent_pool
  - Testa chunking: 25 cards → 3 chamadas (batch 10)
- [ ] `npm test` + `npm run typecheck` passam