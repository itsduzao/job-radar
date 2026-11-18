# Job Radar

Um radar que varre posts do LinkedIn em busca de vagas de estágio e júnior em desenvolvimento de software, confirma a relevância com IA e notifica via Telegram.

## Language

**vaga**:
Oportunidade de trabalho divulgada.
_Avoid_: job, oportunidade, posição, emprego

**post**:
Publicação do feed do LinkedIn que o motor varre em busca de vagas.
_Avoid_: publicação, postagem, conteúdo

**fonte**:
Origem de vagas; o LinkedIn é a primeira.
_Avoid_: site, provider, canal

**run**:
Uma rodada completa de varredura (coleta → dedupe → triagem → digest).
_Avoid_: execução, job, ciclo

**dedupe**:
Etapa do run que descarta posts já vistos (pela chave `id` do post) para não re-notificar.
_Avoid_: deduplicação, filtro de repetidos

**triagem**:
Etapa em que a IA confirma se um post corresponde aos critérios.
_Avoid_: filtro, checagem

**descartado**:
Post que a triagem considerou irrelevante, registrado com um motivo curto.
_Avoid_: rejeitado, ignorado

**digest**:
Mensagem agregada enviada ao Telegram ao fim de cada run.
_Avoid_: resumo, notificação, alerta

**modalidade**:
Forma de trabalho da vaga: remoto, híbrido ou presencial.

**tipo**:
Nível da vaga: estágio ou júnior.

**área**:
Segmento de desenvolvimento de software coberto (backend, frontend, fullstack). QA, DevOps, Mobile e dados ficam de fora.

**critérios**:
Regras (tipo, área, localização, modalidade) que a triagem aplica para decidir se uma vaga é relevante.
_Avoid_: filtros, regras de negócio

**Gupy**:
Plataforma brasileira de recrutamento (portal.gupy.io); segunda fonte de vagas do job-radar.

**banco de talentos**:
Publicação de "cadastro de interesse" no Gupy que não corresponde a vaga aberta; excluída na triagem.

**portal-api.gupy.io**:
Endpoint JSON público usado pela fonte Gupy para busca e detalhe de vagas.

**LLM extraction**:
Etapa em que o Gemini lê o HTML da página de busca do Gupy e devolve as vagas já estruturadas, em vez de depender de seletores CSS/XPath.
_Avoid_: scraping por IA, parsing inteligente

**prompt engineering**:
Prática de escrever e versionar o texto que instrui o modelo (papel, campos, regras e formato de saída); no job-radar o prompt fica em `src/prompts/gupy-extraction-v1.txt`.
_Avoid_: prompt mágico, ajuste de IA

**chunking**:
Divisão do HTML em lotes (por card ou por página) antes de enviar ao modelo, para caber no limite de tokens e reduzir o custo por chamada.
_Avoid_: fatiamento, divisão de texto
