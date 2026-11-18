# ADR-0004: Extração de vagas do Gupy via LLM (HTML → JSON)

## Contexto

A coleta do Gupy carrega o portal de busca com Playwright e extrai as vagas do DOM com seletores CSS/XPath (`[data-testid="job-card"]`, `.job-card`, `article[class*="job"]`). Esses seletores são frágeis por dois motivos:

- O portal usa classes geradas por CSS-in-JS (ex.: `eco-cssveg`, `eco-ks6b7q`) e poucos `data-testid` estáveis.
- Em 2026-11-18, a página real de resultados não casou **nenhum** dos seletores legados de card; apenas `a[href*="/job/"]` casou os 12 cards renderizados. Ou seja, o caminho de seletores já estava silenciosamente quebrado antes desta decisão.

Cada redesign do portal exige inspeção manual do DOM, atualização de seletores e novo deploy. Quando os seletores param de casar, o scraper retorna zero vagas sem erro explícito — a pior falha possível para um radar. A fonte Gupy foi introduzida pelo ADR-0003; este ADR trata apenas de **como extrair os dados do HTML** dessa fonte.

Fatos observados na captura real de 2026-11-18 (ticket 00):

- A rota de resultados é `https://portal.gupy.io/job-search/term=estagio` (o termo é segmento de path). `?term=estagio` renderiza a landing page, não os resultados.
- Os links dos cards são `https://{empresa}.gupy.io/job/{token}`, em que `token` é base64 de `{"jobId":<id>,"source":"gupy_portal"}`; não há `/job/12345` em texto claro.
- A página renderiza 12 cards (o cabeçalho anuncia 100 resultados); a paginação não foi capturada.
- Os cards **não contêm descrição**. Descrição completa, data ISO e localização completa estão em `__NEXT_DATA__.props.pageProps.initialJobList.data[]`.
- Nesse payload, `workplaceType` aparece como `on-site`, enquanto o contrato interno usa `onSite`.

## Decisão

### 1. Extração em dois estágios

```
Playwright (carrega JS e devolve HTML) → Gemini (HTML → JSON validado) → GupySource (JSON → Post)
```

O Playwright deixa de conhecer campos de vaga: ele apenas carrega a página e entrega HTML (`page.content()` ou `outerHTML` dos cards). Toda a interpretação de título, empresa, localização, modalidade, tipo, data e descrição fica no prompt do Gemini. O caminho legado por seletores permanece no código como fallback.

### 2. Contrato do extrator

```ts
export type WorkplaceType = "remote" | "onSite" | "hybrid" | "unknown";
export type JobType = "internship" | "trainee" | "effective" | "talent_pool" | "unknown";

export interface ExtractedJob {
  id: string; // somente dígitos, decodificado do token quando necessário
  title: string;
  company: string;
  location: string; // "Cidade/UF" ou "Remoto"
  workplaceType: WorkplaceType;
  jobType: JobType;
  publishedDate: string; // ISO 8601 ou "unknown"
  description: string; // texto limpo, sem HTML
  url: string; // https://portal.gupy.io/job/{id}
}

export interface JobExtractor {
  extractJobs(htmlChunks: string[], sourceUrl: string): Promise<ExtractedJob[]>;
}
```

- `GeminiExtractor` lê o prompt versionado em `src/prompts/gupy-extraction-v1.txt` (seções `--- SYSTEM ---` e `--- USER ---`) e usa `GEMINI_EXTRACTION_MODEL` (default `gemini-1.5-flash`).
- **Chunking**: `htmlChunks` é opaco para o extrator. Os chunks são concatenados com `\n---\n` e agrupados em lotes de `GEMINI_EXTRACTION_BATCH_SIZE` (default 10), uma chamada sequencial por lote. O scraper decide se cada chunk é o `outerHTML` de um card (modo padrão, tokens limitados) ou o HTML da página inteira (preserva `__NEXT_DATA__` e, portanto, descrições).
- **Validação**: a resposta precisa ser um JSON array; cercas de markdown são removidas; todos os 9 campos são obrigatórios e strings; `id` precisa casar `/^\d+$/`; `workplaceType` e `jobType` precisam estar nos enums; `url` não pode ser vazia.
- **Retry**: resposta inválida dispara até 2 tentativas corretivas (3 tentativas no total), com o motivo da falha anexado ao prompt. Falha de transporte/API não é retentada pelo extrator: o lote falha e o scraper pode cair no fallback legado.
- `GEMINI_EXTRACTION_MAX_TOKENS` (default 8000) limita a saída por chamada.

### 3. Mapeamento para `Post`

O scraper converte cada `ExtractedJob` no mesmo `Post` do caminho legado: `id: "gupy:{id}"`, URL canônica `https://portal.gupy.io/job/{id}` e `texto` enriquecido (Título, Empresa, Localização, Modalidade, Tipo, Publicado, Descrição). A paridade estrutural com os seletores é requisito de aceite.

### 4. Flags e rollout

- `GUPY_USE_LLM_EXTRACTION=false` (default): seletores legados.
- `GUPY_LLM_SHADOW=false` (default): quando ligada, roda LLM **e** seletores, usa os seletores como fonte de verdade e loga divergências (`matched`, `missed`, ids exclusivos de cada lado).
- Com `GUPY_USE_LLM_EXTRACTION=true`, `GEMINI_API_KEY` passa a ser obrigatória e o `loadConfig` falha cedo se ela faltar.
- Rollout: flag off → baseline com seletores → shadow por 3 runs → dry-run da extração com inspeção de `Post[]` → produção. Rollback é desligar a flag, sem deploy.

## Consequências

### Positivas

- A extração sobrevive a mudanças de classe, `data-testid` e estrutura dos cards: o modelo lê o HTML como texto e o prompt concentra o conhecimento do domínio.
- Iterar qualidade não exige deploy de código: o prompt é um arquivo versionado (`v1`, `v2`, ...) e pode ser A/B testado.
- O shadow mode transforma "achismo" em métrica de recall/precisão antes de virar produção.
- Testes permanecem offline: HTML real + JSON esperado em fixtures, `fetch` do Gemini mockado.

### Negativas / limites conhecidos

- **Custo e latência**: cada lote é uma chamada de rede sequencial. Uma página de 12 cards consome aproximadamente 12k tokens de entrada e 6–7k de saída (~US$ 0,003 no `gemini-1.5-flash`); ~50 cards ficam em ~US$ 0,01. O custo cresce por página processada e o run default tem 2 perfis × 13 termos = 26 buscas, então medir com os logs e limitar `GUPY_MAX_PAGES` importa mais do que o número por página.
- **Descrições no modo card-only**: cards não têm descrição. Enviar apenas `outerHTML` de cards produz `description` vazia; para descrições completas é preciso enviar o HTML da página (ou o bloco `__NEXT_DATA__`) como chunk. As duas composições são permitidas pelo contrato, mas o modo card-only é degradado e exige follow-up (detalhe da vaga ou envio do payload estruturado).
- **Não determinismo**: atualizações do modelo podem mudar a saída. Mitigação: prompt versionado, fixtures e execução de avaliação antes de trocar de modelo/prompt.
- **Validação rígida**: hoje um único campo inválido derruba o lote inteiro (que é retentado). O ticket 05 deve normalizar enums desconhecidos para `"unknown"` e descartar apenas a vaga inválida.
- **Dependência de terceiro**: indisponibilidade/quota do Gemini falha a extração; o fallback por seletores evita ficar sem vagas, mas com a cobertura quebrada que motivou este ADR.
- **Chave e custo em CI**: o CI não chama a API real; validação de qualidade acontece via fixtures e em staging.

### Estratégia de teste offline

- `test/fixtures/gupy/search-page-real.html`: página real capturada (rota `/job-search/term=estagio`).
- `test/fixtures/gupy/job-cards-real.json`: 5 `outerHTML` de cards reais.
- `test/fixtures/gupy/extracted-jobs-real.json`: JSON esperado no nível da página, incluindo 1 talent pool.
- Unitários do `GeminiExtractor` mockam `fetch`; o E2E do ticket 06 mocka o extrator e o `$$eval`, garantindo zero rede. O runbook de atualização das fixtures está em `docs/operations.md`.

## Alternativas consideradas

### Melhorar os seletores (rejeitado como solução principal)

Ancorar em `a[href*="/job/"]` e ler o `__NEXT_DATA__` seria mais barato e determinístico que o LLM. Porém o payload do Next.js também muda de forma e de schema sem aviso, os cards não expõem todos os campos e continuaríamos mantendo parsers específicos. O parse de `__NEXT_DATA__` é útil como fonte complementar (o prompt atual o prefere quando presente), não como única estratégia.

### Serviços de scraping gerenciados (rejeitado)

Apify, ScrapingBee e similares resolvem proxy/CAPTCHA, mas continuam entregando HTML ou texto bruto: a interpretação das vagas e a normalização de `talent_pool`/`on-site` continuariam conosco, agora com custo por requisição e um fornecedor extra. Não eliminam o problema central.

### API oficial / JSON pública (preferível quando disponível)

A API pública de busca do Gupy (ADR-0003) evita HTML e LLM, mas não cobre necessariamente a mesma rota, filtros e paginação do portal, e depende de um contrato que pode mudar ou exigir autenticação. Continua sendo a alternativa preferida para dados estruturados; o caminho Playwright + LLM cobre o portal de busca que o scraper efetivamente carrega hoje.

### Modelo local (adiado)

Um LLM local eliminaria custo por token, mas adiciona infraestrutura, latência e qualidade imprevisível no ambiente do GitHub Actions. Sem necessidade medida, não se justifica.

## Referências

- ADR-0002: camada de fonte plugável (`Source`)
- ADR-0003: Gupy como fonte via API pública de busca
- `.scratch/gupy-llm-extraction/spec.md`
- `.scratch/gupy-llm-extraction/map.md`
- Prompt: `src/prompts/gupy-extraction-v1.txt`
- Fixtures: `test/fixtures/gupy/`
