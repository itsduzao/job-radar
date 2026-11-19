# Operação do Job Radar

Guia de operação para o job-radar com suporte a LinkedIn e Gupy.

## Variáveis de Ambiente

### LinkedIn (existentes)
| Variável | Obrigatória | Descrição |
|----------|-------------|-----------|
| `LI_COOKIE` | Sim (para LinkedIn) | Cookie de sessão do LinkedIn (`li_at`) |
| `TELEGRAM_BOT_TOKEN` | Sim | Token do bot do Telegram |
| `TELEGRAM_CHAT_ID` | Sim | Chat ID para envio do digest |
| `GEMINI_API_KEY` | Sim | Chave da API do Gemini para triagem |

### Gupy (novas)
| Variável | Default | Descrição |
|----------|---------|-----------|
| `ENABLE_GUPY_SOURCE` | `false` | Ativa a fonte Gupy |
| `GUPY_DRY_RUN` | `false` | Modo dry-run: busca e loga, mas não faz triagem nem envia digest |
| `GUPY_MAX_PAGES` | `20` | Máximo de páginas por query (proteção contra loop infinito) |
| `GUPY_MAX_AGE_DAYS` | `30` | Idade máxima da vaga em dias (filtra vagas antigas) |
| `GUPY_TIMEOUT_MS` | `15000` | Timeout por request em ms |
| `GUPY_MAX_RETRIES` | `3` | Máximo de tentativas em erros retryable (429, 5xx) |
| `GUPY_BASE_DELAY_MS` | `1000` | Delay base para backoff exponencial em ms |

### LLM Extraction (Gupy)
| Variável | Default | Descrição |
|----------|---------|-----------|
| `GUPY_USE_LLM_EXTRACTION` | `false` | Ativa a extração de vagas via Gemini (substitui os seletores CSS/XPath) |
| `GUPY_LLM_SHADOW` | `false` | Modo shadow (ticket 06): roda LLM e seletores, usa os seletores como verdade e loga divergências |
| `GEMINI_EXTRACTION_MODEL` | `gemini-3.5-flash-lite` | Modelo Gemini usado na extração |
| `GEMINI_EXTRACTION_MAX_TOKENS` | `8000` | Máximo de tokens de saída por chamada (inteiro positivo) |
| `GEMINI_EXTRACTION_BATCH_SIZE` | `10` | Cards de vaga enviados por chamada ao Gemini (inteiro positivo) |
| `GEMINI_TIMEOUT_MS` | `30000` | Timeout por chamada ao Gemini em ms (inteiro positivo); estourou, o lote falha e cai no fallback/legacy |
| `GEMINI_INPUT_COST_PER_MILLION` | `0.30` | Custo em US$ por 1M tokens de entrada, usado no log `estimatedCostUsd` |
| `GEMINI_OUTPUT_COST_PER_MILLION` | `2.50` | Custo em US$ por 1M tokens de saída, usado no log `estimatedCostUsd` |

Com `GUPY_USE_LLM_EXTRACTION=true`, `GEMINI_API_KEY` passa a ser **obrigatória**: o `loadConfig` falha na inicialização se ela estiver ausente ou vazia. Com a flag desligada, a chave continua opcional (usada apenas pela triagem). **O modo shadow também precisa da chave**: com `GUPY_LLM_SHADOW=true` e sem `GEMINI_API_KEY`, o processo loga um `warn` e segue só com seletores (não quebra). Se `GUPY_USE_LLM_EXTRACTION=true` e `GUPY_LLM_SHADOW=true` ao mesmo tempo, vale o modo LLM puro (shadow é ignorado). Valores inválidos, zero ou negativos em `GEMINI_EXTRACTION_MAX_TOKENS`, `GEMINI_EXTRACTION_BATCH_SIZE` ou `GEMINI_TIMEOUT_MS` caem no default.

#### Custo estimado

Referência de preço do `gemini-3.5-flash-lite` (lista, nov/2026): **US$ 0,30 por 1M tokens de entrada** e **US$ 2,50 por 1M tokens de saída**. O custo é dominado pelo volume de HTML enviado e pelas descrições devolvidas, não pelo número de chamadas.

- Uma página de 12 cards ≈ 23k tokens de entrada + 1,8k de saída ≈ **US$ 0,0115** (medido em 2026-11-19).
- ~50 cards (5 lotes com `batch=10`) ≈ **US$ 0,05**.
- O run default tem 2 perfis × 13 termos = **26 buscas**; o custo cresce por página processada. Com 1 página por busca o total fica na casa de US$ 0,30; com muitas páginas (`GUPY_MAX_PAGES`) pode passar de US$ 1. Acompanhe `inputTokens`/`outputTokens` nos logs e ajuste `GUPY_MAX_PAGES` antes de ligar a flag em produção.
- **Batch menor** (ex.: 5) aumenta o número de chamadas, o overhead do prompt e a latência; **batch maior** (ex.: 20) reduz chamadas, mas aproxima a saída do teto de `GEMINI_EXTRACTION_MAX_TOKENS`. O total de tokens de entrada muda pouco — o ganho é latência/requests.
- **`GEMINI_EXTRACTION_MAX_TOKENS`** limita a saída, não o gasto diretamente. Baixo demais trunca o JSON, o que dispara as 2 retentativas corretivas e **triplica** o custo daquele lote. O default 8000 acomoda ~10–15 vagas com descrição.
- O modo card-only é mais barato (sem descrições); enviar o HTML da página inteira para preservar `__NEXT_DATA__` aumenta a entrada por chamada. Meça os dois antes de escolher o default.
- **Timeout e métricas**: `GEMINI_TIMEOUT_MS` aborta a chamada individual; um lote que estoura o timeout falha e cai no fallback por seletores (modo puro) ou mantém a saída legacy (shadow). Cada lote loga `inputTokens`, `outputTokens`, `latencyMs` e `retryCount`; o fim do run loga `gupy extraction run summary` com `totalTokens` e `estimatedCostUsd`. Ajuste os preços via `GEMINI_INPUT_COST_PER_MILLION` / `GEMINI_OUTPUT_COST_PER_MILLION` se a tabela do provedor mudar.

#### Atualizando as fixtures

As fixtures são a rede de segurança dos testes offline. Repita este runbook quando o portal mudar (cards vazios, campos errados, data/descrição ausentes) — foi o procedimento usado no ticket 00 em 2026-11-18.

1. Instale o Chromium: `npx playwright install chromium`.
2. Abra `https://portal.gupy.io/`, preencha `input[placeholder="Busque por uma vaga"]` com o termo (ex.: `estagio`) e pressione Enter. A URL precisa virar **`/job-search/term=estagio`**; `?term=estagio` abre a landing page e não serve.
3. Espere os links `a[href*="/job/"]` (12 cards observados), role a página algumas vezes para disparar o lazy-load e salve `page.content()` em `test/fixtures/gupy/search-page-real.html`.
4. A partir de 3–5 links de vaga, suba no DOM até o container do card (o ancestral que contém o link, imagem e textos da vaga) e salve os `outerHTML` como array JSON em `test/fixtures/gupy/job-cards-real.json`.
5. Derive manualmente o JSON esperado em `test/fixtures/gupy/extracted-jobs-real.json`. Inclua pelo menos 1 talent pool. Use `__NEXT_DATA__.props.pageProps.initialJobList.data[]` para descrição, data ISO, localização completa e `workplaceType`; normalize `on-site` → `onSite`. Decodifique o token do link com `Buffer.from(token, "base64").toString()` para obter `jobId` (somente dígitos).
6. Rode `npm test` e confira que contagens (12 links por página) e campos batem com o HTML salvo. Commit das fixtures e do JSON esperado juntos.

Script auxiliar (one-off, não precisa ser commitado):

```js
// scripts/capture-gupy-fixture.mjs
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const term = process.argv[2] ?? "estagio";
const search = 'input[placeholder="Busque por uma vaga"]';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

await page.goto("https://portal.gupy.io/", { waitUntil: "domcontentloaded" });
await page.fill(search, term);
await Promise.all([
  page.waitForURL(new RegExp(`/job-search/term=${encodeURIComponent(term)}`)),
  page.press(search, "Enter"),
]);
await page.waitForSelector('a[href*="/job/"]', { timeout: 30_000 });
for (let i = 0; i < 5; i++) {
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(500);
}

writeFileSync("test/fixtures/gupy/search-page-real.html", await page.content());

const cards = await page.$$eval('a[href*="/job/"]', (links) =>
  links.slice(0, 5).map((link) => {
    let el = link;
    for (let depth = 0; depth < 8 && el.parentElement; depth++) {
      el = el.parentElement;
      const onlyLink = el.querySelectorAll('a[href*="/job/"]').length === 1;
      if (onlyLink && el.querySelector("img")) break;
    }
    return el.outerHTML;
  }),
);
writeFileSync("test/fixtures/gupy/job-cards-real.json", JSON.stringify(cards, null, 2) + "\n");
await browser.close();
```

#### Troubleshooting da extração

**JSON inválido / resposta com markdown**
- O extrator remove cercas de código markdown e tenta até 2 retentativas corretivas. Se o lote falhar mesmo assim, veja o campo `error` no log `gupy extraction batch failed`.
- Reduza `GEMINI_EXTRACTION_BATCH_SIZE` (menos vagas por resposta) e confirme que `GEMINI_EXTRACTION_MAX_TOKENS` não está truncando a saída.
- Reproduza com o HTML de `test/fixtures/gupy/` e ajuste o prompt em uma nova versão (`gupy-extraction-v2.txt`), nunca reescrevendo a v1.

**Limite de tokens / saída truncada**
- Sintoma: JSON incompleto, `Unexpected end of JSON input`, lote sempre falhando no mesmo ponto.
- Ação: diminua o batch; no modo página inteira, considere enviar só os cards ou o bloco `__NEXT_DATA__`; aumente `GEMINI_EXTRACTION_MAX_TOKENS` se as descrições forem longas.
- Falha de quota/429 ou 5xx do Gemini é retentada até 2 vezes com backoff; se persistir, o lote cai no fallback por seletores. Verifique a chave e o billing.

**Talent pool (falso negativo)**
- Sintoma: vaga "Banco de Talentos"/"Cadastro de Interesse" aparece como `internship`/`effective`.
- Causa: título ambíguo ou card sem o texto explícito; o modelo pode priorizar "estágio" no título.
- Ação: confira a regra de `jobType: "talent_pool"` no prompt, adicione um card real ao fixture e valide. Lembre que cards sem link `/job/` não são vagas e devem ser ignorados.

**`on-site` / enums desconhecidos**
- O portal expõe `on-site` em `__NEXT_DATA__`; o contrato usa `onSite`. O prompt normaliza, mas variações novas (`onsite`, `presencial`, `home office`) podem escapar.
- Desde o ticket 05, um enum inválido de `workplaceType`/`jobType` é normalizado para `"unknown"` e a vaga **não** derruba o lote. Só vaga sem `id` numérico válido ou sem `title` é descartada, com log `dropped_invalid_job` (`batchIndex`, `index`, `reason`); as demais seguem no resultado. Se o log mostrar muitos drops, inspecione a resposta do modelo e ajuste o prompt.

**Zero cards**
- Confirme a rota: `/job-search/term=<termo>` (path), não `?term=<termo>`.
- Conte `a[href*="/job/"]` na página salva. Se houver links e o LLM retornar `[]`, o HTML enviado pode não conter os cards (JS não renderizado) ou o batch pode estar vazio.
- Um resultado vazio do LLM não gera `Post[]` e encerra a paginação com segurança (sem loop nem retry infinito).
- Se não houver links, o portal mudou de layout/rota: recapture as fixtures com o runbook acima antes de mexer no prompt.

#### Modo shadow e log de divergência

`GUPY_LLM_SHADOW=true` (com `GEMINI_API_KEY`) roda, por página, a extração LLM **e** os seletores legados. A saída de produção continua sendo a dos seletores — o modo serve só para medir recall/precisão antes de ligar `GUPY_USE_LLM_EXTRACTION`. Se a chamada ao Gemini falhar, o erro vira `warn` e a saída legacy é mantida; o run não quebra.

Um log por página processada:

```json
{"level":"info","source":"gupy","msg":"shadow","shadow":true,"page":0,"cardsLegacy":12,"cardsLlm":11,"idsOnlyLegacy":["12916776"],"idsOnlyLlm":["12855594"],"matched":10,"missed":1}
```

- `cardsLegacy` / `cardsLlm`: vagas devolvidas por cada caminho.
- `matched`: ids presentes nos dois caminhos.
- `missed`: quantidade de ids legacy ausentes no LLM (igual ao tamanho de `idsOnlyLegacy`) — perda de recall.
- `idsOnlyLegacy`: ids exclusivos dos seletores (o LLM não achou).
- `idsOnlyLlm`: ids exclusivos do LLM (candidato a ganho de recall; confira se são vagas reais).
- `page`: índice zero-based da página.

#### Validação offline (E2E)

O gate offline não usa rede: Playwright e Gemini são mockados e as fixtures reais alimentam o scraper.

```bash
npm test                                      # suíte completa, incluindo o E2E
npx vitest run test/gupy-llm-e2e.test.ts      # só o gate E2E
```

`test/gupy-llm-e2e.test.ts` carrega `test/fixtures/gupy/job-cards-real.json` e `extracted-jobs-real.json`, cobre `Post[]` do modo LLM (5 vagas, ids `gupy:{id}`, URL canônica e bloco `texto`), o log `shadow`, o caso de zero vagas (parada de paginação) e garante que `fetch` nunca é chamado. Rode antes de qualquer mudança de prompt/seletor.

#### Validação em staging

1. **Baseline (seletores)**: `ENABLE_GUPY_SOURCE=true GUPY_USE_LLM_EXTRACTION=false GUPY_LLM_SHADOW=false`. Registre ids coletados e duração. Se o baseline já vier vazio, os seletores estão quebrados — não use esse número como referência.
2. **Shadow (3 runs)**: `ENABLE_GUPY_SOURCE=true GUPY_USE_LLM_EXTRACTION=false GUPY_LLM_SHADOW=true`. A produção continua usando seletores; compare nos logs `shadow` os campos `matched`, `missed`, `idsOnlyLegacy` e `idsOnlyLlm`. Três runs consecutivos mostram se a divergência é estável ou ruído.
3. **Dry-run da extração**: `GUPY_USE_LLM_EXTRACTION=true GUPY_LLM_SHADOW=false`. Atenção: `GUPY_DRY_RUN=true` retorna `[]` **antes** de chamar o scraper (`GupySource.fetchPosts`), então ele não exercita a extração. Para inspecionar `Post[]`, rode com `GUPY_DRY_RUN=false` e sem credenciais do Telegram (digest desativado), ou use o modo shadow para comparar sem mudar a produção. Confira ids `gupy:{id}`, URLs canônicas e o bloco `texto` enriquecido.
4. **Produção**: ligue `GUPY_USE_LLM_EXTRACTION=true` e monitore os 3 primeiros runs. Critérios de aceite: mesmos ids do baseline (ou melhores), nenhum aumento de buscas com zero cards, custo dentro da faixa estimada. Rollback: `GUPY_USE_LLM_EXTRACTION=false` (sem deploy).

## Perfis de Busca Padrão (Gupy)

Quando `ENABLE_GUPY_SOURCE=true`, os seguintes perfis são ativados automaticamente:

1. **florianopolis-sc** — Grande Florianópolis (SC)
   - Cidades: Florianópolis, São José, Palhoça, Biguaçu, Santo Amaro da Imperatriz
   - Modalidades: remoto, híbrido, presencial
   - Tipos: estágio, trainee, efetivo

2. **remote-br** — Remoto Brasil
   - Modalidades: apenas remoto
   - Tipos: estágio, trainee, efetivo

### Termos de Busca Padrão
```
estagio, estagiaria, estágio, estagiária, jr, junior, júnior,
desenvolvedor, dev, backend, frontend, fullstack, full stack
```

## Como Fazer Dry-Run

```bash
# Testa a coleta do Gupy sem disparar triagem/digest
GUPY_DRY_RUN=true ENABLE_GUPY_SOURCE=true npm start
```

Saída esperada: logs JSON estruturados mostrando queries executadas, vagas coletadas, duração, etc. Nenhuma mensagem no Telegram.

> **Atenção:** hoje `GUPY_DRY_RUN=true` retorna `[]` **antes** de chamar o scraper (`GupySource.fetchPosts`). O dry-run valida configuração, wiring e o caminho sem triagem/digest — não a coleta em si. Para validar extração, use a sequência de staging da seção de LLM com `GUPY_DRY_RUN=false`.

## Logs Estruturados

Todos os logs agora são JSON Lines (uma linha = um objeto JSON). Exemplos:

```json
{"ts":"2026-10-15T10:00:00.000Z","level":"info","source":"gupy","msg":"Gupy query completed","profile":"florianopolis-sc","term":"estagio","collected":12,"durationMs":1250,"rateLimitRemaining":87}
{"ts":"2026-10-15T10:00:00.000Z","level":"info","source":"run","msg":"Collection completed","collected":45}
{"ts":"2026-10-15T10:00:00.000Z","level":"warn","source":"gupy","msg":"Gupy rate limit low","profile":"remote-br","term":"junior","rateLimitRemaining":3}
```

### Consultas úteis com `jq`

```bash
# Ver apenas erros
tail -f logs.json | jq 'select(.level=="error")'

# Agrupar por source
tail -f logs.json | jq -s 'group_by(.source) | map({source: .[0].source, count: length})'

# Ver queries Gupy lentas (>5s)
tail -f logs.json | jq 'select(.source=="gupy" and .durationMs > 5000)'

# Contar vagas por perfil
tail -f logs.json | jq -s 'map(select(.source=="gupy")) | group_by(.profile) | map({profile: .[0].profile, total: map(.collected) | add})'
```

## Troubleshooting

### Rate Limit (429 / 403)
- **Sintoma**: Logs `warn` com `rateLimitRemaining` baixo ou erros 429/403
- **Ação**: 
  - Aguarde alguns minutos (o client já faz retry automático com backoff)
  - Se persistir, reduza `GUPY_MAX_PAGES` ou aumente `GUPY_BASE_DELAY_MS`
  - Em último caso, rotação de IP ou uso de proxy

### `seen.json` Growth
- **Sintoma**: Arquivo `data/seen.json` cresce indefinidamente
- **Ação**: Monitorar tamanho do arquivo. Limite conhecido: ~100k entries antes de degradação de performance. Migração futura para SQLite/LMDB planejada.

### Duplicatas Cross-Source no 1º Run
- **Sintoma**: Vagas aparecem duplicadas no digest (uma do LinkedIn, uma do Gupy)
- **Causa**: IDs namespaces diferentes (`urn:li:...` vs `gupy:...`); dedupe cross-source não implementado
- **Ação**: Esperado no 1º run. A triagem do Gemini descarta duplicatas semânticas. Em runs subsequentes, o `seen.json` impede re-notificação.

### Nenhuma Vaga Coletada
- **Verificar**: 
  - `ENABLE_GUPY_SOURCE=true` está definido?
  - `GUPY_DRY_RUN=false` (ou não definido)?
  - Logs mostram queries sendo executadas?
  - Rate limit não está zerado?

## Checklist de Rollout

1. **Dry-run**: `GUPY_DRY_RUN=true ENABLE_GUPY_SOURCE=true npm start`
   - Verificar logs: queries executadas, vagas coletadas > 0
   - Confirmar estrutura do `texto` nas vagas (Título, Empresa, Localização, Modalidade, Tipo, Publicado, Descrição)

2. **Enable**: `ENABLE_GUPY_SOURCE=true npm start` (sem dry-run)
   - Monitorar 3 runs consecutivos
   - Verificar digest no Telegram: vagas Gupy aparecem com link `portal.gupy.io`
   - Confirmar ausência de spam/duplicatas excessivas

3. **Produção**: Manter monitoramento de logs e rate limits
   - Alertar se `rateLimitRemaining < 5` frequente
   - Alertar se `seen.json` > 50k entries