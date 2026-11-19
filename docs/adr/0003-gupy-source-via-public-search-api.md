# ADR-0003: Gupy Source via Public Search API

## Context

O job-radar atualmente só varre o LinkedIn como fonte de vagas. Muitas vagas de estágio e júnior em desenvolvimento de software no Brasil são publicadas primariamente (ou exclusivamente) no Gupy (portal.gupy.io). O operador precisa que o pipeline descubra, deduplique, triage (via Gemini) e entregue essas vagas no mesmo digest do Telegram — sem mudar a experiência de triagem/digest.

Este ADR documenta a decisão de adicionar Gupy como segunda `Source` plugável ao lado do LinkedIn, consumindo a **API pública de busca do Gupy** (`portal-api.gupy.io/api/v1/jobs`) via HTTP/JSON (não Playwright).

Referencia: ADR-0002 (pluggable-source-layer).

## Decision

### 1. Source Implementation: Public Search JSON API (not Playwright)
- `GupySource` usa `fetch` nativo (Node 24) contra `portal-api.gupy.io/api/v1/jobs`.
- Paginação: `page=0,1,2...` até `data.length === 0` ou `data.length < pageSize` (default 50), teto `maxPages=20` (env `GUPY_MAX_PAGES`).
- Detalhe da vaga: search endpoint já retorna `description` (HTML); se ausente/truncado (< 200 chars), fallback GET `/api/v1/jobs/{id}`.
- Rate limiting: `HttpClient` reutilizável com retry exponencial (3x, base 1s, max 30s), respeita `Retry-After`, timeout 15s (env overrides: `GUPY_MAX_RETRIES`, `GUPY_BASE_DELAY_MS`, `GUPY_TIMEOUT_MS`).
- Erros: classifica 429/403/timeout com mensagens acionáveis; coleta erros por query, logga, continua outras queries; falha total só se todas queries falharem.

### 2. Configuração: Matriz Declarativa + Feature Flag
- Novo tipo `GupySearchConfig` (discriminated union em `Query` via `source: "gupy"`):
```ts
interface GupySearchProfile {
  name: string;
  state?: string;
  cities?: string[];
  workplaceTypes?: string[]; // "remote" | "onSite" | "hybrid"
  jobTypes?: string[];       // "vacancy_type_internship" | "vacancy_type_trainee" | "vacancy_type_effective"
}
interface GupySearchConfig {
  source: "gupy";
  profiles: GupySearchProfile[];
  terms: string[];
}
```
- `loadConfig` lê `ENABLE_GUPY_SOURCE` (default false); se true, injeta `GupySearchConfig` default com os 2 perfis + 5 termos base + variantes acentuadas.
- Validação fail-fast: lança `Error` se Gupy habilitado mas `profiles` vazio ou `terms` vazio.

### 3. Identidade & Dedupe
- `Post.id = "gupy:{numericId}"` (namespaced, estável cross-run).
- URL canônica: `https://portal.gupy.io/job/{id}` (sem query params).
- Cross-term dedupe dentro do `GupySource` (Set por `numericId` antes de retornar `Post[]`).
- Cross-source dedupe (LinkedIn vs Gupy): **não implementado** — IDs namespaces diferentes; Gemini descarta duplicatas semânticas.

### 4. Mapeamento para `Post.texto` (enriquecimento estruturado)
`GupySource` formata bloco no `texto`:
```
Título: {name}
Empresa: {companyName}
Localização: {city}/{state}
Modalidade: {presencial|hibrido|remoto}  // mapeado de workplaceType
Tipo: {estagio|junior}                   // mapeado de jobType: internship→estagio, trainee/effective→junior
Publicado: {publishedDate}
Descrição: {descriptionHtml[:3000]}
```
- `workplaceType`: remote→remoto, onSite→presencial, hybrid→hibrido.
- `jobType`: vacancy_type_internship→estagio, vacancy_type_trainee→junior, vacancy_type_effective→junior.
- `publishedDate` parseado com `new Date().getTime()`; ordenação decrescente no source; filtro `maxAgeDays=30` (env `GUPY_MAX_AGE_DAYS`).

### 5. Triage Prompt Update
- Adicionar critério de exclusão: "Banco de Talentos / Talent Pool / Cadastro de Interesse / bancos de currículo".
- Se API expuser campo `isTalentPool` ou similar, pré-filtrar no source (barato) + guardrail no prompt.

### 6. Integração no Pipeline
- `main.ts`: lê `ENABLE_GUPY_SOURCE`; se true, adiciona `GupySource` instances ao array `sources` (uma por query Gupy).
- `run.ts`: `collect` usa `Promise.allSettled` (paralelo, falha isolada); log estruturado por source.
- `digest.ts`: inalterado (link `portal.gupy.io` já identifica fonte).

### 7. Logging Estruturado
- Novo `src/logger.ts`: `info/warn/error` → `JSON.stringify({ts, level, source, msg, ...fields})`.
- Migrar `main.ts`, `run.ts`, `GupySource`, `LinkedInSource` progressivamente.

### 8. Testes & Fixtures
- `test/fixtures/gupy/` com: `search-page-1.json`, `search-page-2.json`, `search-empty.json`, `job-detail.json`, `error-429.json`, `error-403.json`, `talent-pool.json`.
- `GupySource.test.ts`: paginação, dedupe cross-term, retry 429, fallback description, mapeamento tipos, talent pool filter.
- `HttpClient.test.ts`: retry 429, retry 5xx, timeout, abort, success.
- `config.test.ts`: validação fail-fast Gupy.
- `run.test.ts`: `collect` paralela com sources mockadas, IDs namespaces diferentes.

### 9. Documentação
- ADR-0003: `docs/adr/0003-gupy-source-via-public-search-api.md` (referencia ADR-0002).
- `GLOSSARY.md`: entradas "Gupy", "banco de talentos", "portal-api.gupy.io".
- `docs/operations.md`: variáveis Gupy + defaults, dry-run, logs estruturados, troubleshooting (429/403, seen.json growth, duplicatas 1º run).

### 10. Rollout Flags
- `ENABLE_GUPY_SOURCE` (default false) — ativa source.
- `GUPY_DRY_RUN` (default false) — fetch + log, retorna `[]` (sem triagem/digest).

## Consequences

### Positive
- Fonte Gupy integrada sem quebrar contrato `Source` existente.
- Testes determinísticos com fixtures JSON (sem rede em CI).
- Configuração declarativa reduz manutenção de query strings.
- Resiliência via retry/backoff/circuit-breaker.
- Logs estruturados facilitam observabilidade.

### Negative / Known Limits
- Cross-source dedupe (LinkedIn ↔ Gupy) não implementado — IDs namespaces diferentes; aceitar duplicatas semânticas no 1º run.
- `FileSeenStore` em JSON tem limite conhecido (>100k entries); migração futura para SQLite/LMDB documentada.
- API pública do Gupy não requer autenticação; se rate limits exigirem, adicionar `GUPY_API_KEY` env depois.
- Playwright fallback para Gupy fora de escopo — API JSON é estável e suficiente.

## Alternatives Considered

### Playwright Scraping (rejeitado)
- Mais frágil (seletores CSS, login walls, CAPTCHA).
- Mais lento e resource-intensive.
- API JSON pública é estável e retorna todos os campos necessários.

### Cross-source dedupe no `seen.json` (rejeitado)
- Requereria chave de dedupe semântica (título+empresa+localização) — propensa a falsos positivos/negativos.
- Gemini já faz isso bem na triagem; manter simples.

### Autenticação Gupy via API Key (adiado)
- API pública não requer; adicionar quando/precisar.

## References
- ADR-0002: Pluggable Source Layer
- Spec: `.scratch/gupy-source/spec.md`
- Ticket Map: `.scratch/gupy-source/map.md`