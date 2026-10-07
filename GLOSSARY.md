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
