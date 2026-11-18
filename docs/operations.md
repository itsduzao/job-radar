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
| `GEMINI_EXTRACTION_MODEL` | `gemini-1.5-flash` | Modelo Gemini usado na extração |
| `GEMINI_EXTRACTION_MAX_TOKENS` | `8000` | Máximo de tokens de saída por chamada (inteiro positivo) |
| `GEMINI_EXTRACTION_BATCH_SIZE` | `10` | Cards de vaga enviados por chamada ao Gemini (inteiro positivo) |

Com `GUPY_USE_LLM_EXTRACTION=true`, `GEMINI_API_KEY` passa a ser **obrigatória**: o `loadConfig` falha na inicialização se ela estiver ausente ou vazia. Com a flag desligada, a chave continua opcional (usada apenas pela triagem).

**Custo estimado:** com `batch=10` e ~50 cards por run (5 chamadas de ~10k tokens de entrada e ~2k de saída), o custo fica em torno de **US$ 0,007 por run** no `gemini-1.5-flash` — abaixo de US$ 0,01. Valores inválidos, zero ou negativos em `GEMINI_EXTRACTION_MAX_TOKENS` ou `GEMINI_EXTRACTION_BATCH_SIZE` caem no default.

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