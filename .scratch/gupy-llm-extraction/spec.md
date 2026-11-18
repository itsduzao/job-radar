# Spec: LLM-based HTML Extraction for Gupy Jobs

## Problem Statement

O `GupyPlaywrightScraper` atual usa seletores CSS/XPath frágeis (`[data-testid="job-card"]`, `.job-card`, etc.) que quebram quando o Gupy muda o layout. Cada mudança no site requer manutenção manual de seletores.

## Solution

Substituir a extração baseada em seletores por **extração via LLM (Gemini)**: o Playwright carrega a página e retorna o **HTML bruto** (ou `outerHTML` dos cards), e o Gemini extrai os campos estruturados (id, title, company, location, workplaceType, jobType, publishedDate, description, url) via prompt engenheirado.

## User Stories

1. As a **developer**, I want the Gupy scraper to survive layout changes without code updates, so that I don't spend time fixing broken selectors.
2. As an **operator**, I want the scraper to continue working when Gupy redesigns their job cards, so that my pipeline doesn't silently fail.
3. As a **developer**, I want the extraction logic to be in a prompt (not code), so that I can iterate on extraction quality without redeploying.

## Implementation Decisions

### 1. Architecture: Two-Stage Extraction

```
Playwright (fetch HTML) → Gemini (extract JSON) → GupySource (map to Post)
```

- **Stage 1 (Playwright)**: `page.content()` ou `cards.map(el => el.outerHTML)` — apenas carrega JS e retorna HTML. Zero seletores de extração.
- **Stage 2 (Gemini)**: Recebe HTML + prompt → retorna `Job[]` JSON validado.
- **Fallback**: Se Gemini falhar, tentar seletores legados (compatibilidade).

### 2. Gemini Extraction Interface

```typescript
// src/gemini-extractor.ts
export interface GeminiExtractor {
  extractJobs(html: string, sourceUrl: string): Promise<ExtractedJob[]>;
}

export interface ExtractedJob {
  id: string;                    // numeric ID from URL /job/12345
  title: string;
  company: string;
  location: string;
  workplaceType: "remote" | "onSite" | "hybrid" | "unknown";
  jobType: "internship" | "trainee" | "effective" | "talent_pool" | "unknown";
  publishedDate: string;         // ISO string
  description: string;
  url: string;                   // full canonical URL
}
```

### 3. Prompt Engineering

**System Prompt** (fixo, versionado):
```
Você é um extrator de vagas do portal.gupy.io.
Recebe HTML de uma página de busca e retorna JSON array com as vagas.

Campos obrigatórios por vaga:
- id: número da vaga (extraia da URL /job/12345 → "12345")
- title: título da vaga
- company: nome da empresa
- location: "Cidade/UF" ou "Remoto"
- workplaceType: "remote" | "onSite" | "hybrid" | "unknown"
- jobType: "internship" | "trainee" | "effective" | "talent_pool" | "unknown"
- publishedDate: ISO 8601 (ex: "2026-10-15T10:00:00-03:00")
- description: texto completo da descrição
- url: URL canônica completa (https://portal.gupy.io/job/12345)

Regras:
- Ignore "Banco de Talentos", "Cadastro de Interesse", "Talent Pool" → jobType: "talent_pool"
- Se workplaceType não claro, use "unknown"
- Se jobType não claro, use "unknown"
- publishedDate: procure por "Publicado em", "há X dias", data no card
- description: texto limpo, sem HTML tags
- Retorne APENAS JSON array válido, sem markdown, sem explicações
```

**User Prompt** (dinâmico):
```
HTML da página: {html}
URL de origem: {sourceUrl}
```

### 4. Chunking Strategy

Página de busca do Gupy pode ter 50+ cards → HTML > 100KB. Gemini tem limite de tokens.

**Estratégia**:
1. Playwright extrai `outerHTML` de **cada card individual** (`$$eval` com `el.outerHTML`)
2. Envia **lotes de 10-15 cards** por chamada Gemini
3. Agrega resultados

```typescript
// No scraper:
const cardHtmls = await page.$$eval(CARD_SELECTOR, els => els.map(el => el.outerHTML));
// cardHtmls: string[] (cada item = HTML de 1 card)

// Processa em lotes:
for (const chunk of chunkArray(cardHtmls, 10)) {
  const jobs = await geminiExtractor.extractJobs(chunk.join("\n---\n"), url);
  allJobs.push(...jobs);
}
```

### 5. Validation & Retry

- Validação Zod/JSON Schema no resultado Gemini
- Retry 2x com prompt corretivo se validação falhar
- Log estruturado: tokens usados, latência, sucesso/falha

### 6. Cost Control

- `GEMINI_EXTRACTION_MAX_TOKENS` env (default: 8000 output)
- `GEMINI_EXTRACTION_BATCH_SIZE` env (default: 10)
- Log custo estimado por run

### 7. Feature Flag

- `GUPY_USE_LLM_EXTRACTION=true` (default: false para rollout seguro)
- Se false, usa seletores legados (código atual mantido como fallback)

## Testing Decisions

- **Unit**: `GeminiExtractor` com HTML fixtures reais (salvar `test/fixtures/gupy/page-html.html`)
- **Integration**: Mock `fetch` do Gemini, testar chunking + agregação
- **E2E**: Dry-run com HTML real salvo (não chama API real em CI)
- **Fixtures**: HTML de página real + JSON esperado extraído

## Out of Scope

- Treinamento de modelo customizado
- Cache de extrações (pode adicionar depois)
- Extração de detalhes da vaga (página `/job/12345`) — só se descrição no card for insuficiente

## Further Notes

- Prompt versionado em `src/prompts/gupy-extraction-v1.txt` (facilita A/B testing futuro)
- Manter seletores legados como fallback por 2 releases
- Documentar custo estimado em `docs/operations.md`