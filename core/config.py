
import os
from dotenv import load_dotenv

load_dotenv()

# Cargo forte: título que já deixa claro que a vaga é de estágio em
# desenvolvimento de software (fullstack, front-end, back-end ou engenharia
# de software). Esses termos aprovam pelo título sem exigir outro
# qualificador, porque o próprio cargo já traz o recorte de estágio.
KEYWORDS_CARGO_FORTE = [
    "Estágio em Desenvolvimento",
    "Estágio Fullstack",
    "Estágio Full Stack",
    "Estágio Front-end",
    "Estágio Back-end",
    "Estagiário de TI",
    "Estagiário de Tecnologia",
    "Estágio em Engenharia de Software",
    "Estágio em Programação",
    "Software Engineering Intern",
    "Development Intern",
]

# Cargo ambíguo: títulos gerais de desenvolvimento também aparecem em vagas
# efetivas/plenas/sêniores. Só contam como match quando o título TAMBÉM traz
# um qualificador explícito de estágio/internship.
KEYWORDS_CARGO_AMBIGUO = [
    "Desenvolvedor",
    "Programador",
    "Engenheiro de Software",
    "Software Engineer",
    "Web Developer",
]

# Termo que precisa aparecer junto no título quando o cargo é ambíguo, para
# confirmar que é uma oportunidade de estágio e não uma vaga efetiva. O nome
# novo reflete o domínio atual (tecnologia/software); o alias antigo fica só
# para manter compatibilidade com RegrasFiltro/perfis.py, que ainda usa o
# campo genérico `qualificadores_dados`.
QUALIFICADORES_TECH = [
    "estágio",
    "estagiário",
    "intern",
    "internship",
]
QUALIFICADORES_DADOS = QUALIFICADORES_TECH

# Stack principal que pode aparecer como núcleo do título (ex: "Estágio
# React", "Intern Node.js"). Só conta como match se o título também tiver
# uma palavra de estágio em QUALIFICADORES_CARGO, evitando aprovar vagas
# efetivas apenas por citarem uma tecnologia.
FERRAMENTAS_TITULO = [
    "javascript",
    "typescript",
    "node",
    "react",
    "nextjs",
    "java",
    "docker",
    "gcp",
    "google cloud",
    "python",
    "sql",
    "tailwind",
]

# Palavra de cargo/nível que confirma que uma vaga encontrada por tecnologia
# é realmente estágio.
QUALIFICADORES_CARGO = [
    "estágio",
    "estagiário",
    "intern",
    "internship",
]

KEYWORDS = KEYWORDS_CARGO_FORTE + KEYWORDS_CARGO_AMBIGUO

# Termos de busca enviados a cada site. Ficam separados das KEYWORDS de
# propósito: TERMOS_BUSCA é a rede ampla (o que é pesquisado em cada site,
# incluindo termos de stack para achar vaga com título atípico), enquanto
# KEYWORDS é o filtro final de cargo. Um termo de tecnologia só resulta em
# notificação se o TÍTULO da vaga também tiver sinal de estágio/cargo pela
# regra de RegrasFiltro.
TERMOS_CARGO_EXTRA = [
    # Variações amplas comuns em anúncios que nem sempre repetem exatamente
    # as keywords fortes acima.
    "estágio desenvolvimento software",
    "estágio desenvolvedor",
    "estágio programação",
    "estágio ti",
    "intern software",
]

TERMOS_CARGO = sorted(set(k.lower() for k in KEYWORDS) | set(TERMOS_CARGO_EXTRA))

# Tecnologias da stack principal usadas como termos de busca para capturar
# anúncios com títulos atípicos, sem referências a ferramentas exclusivas de
# análise de dados ou BI.
TERMOS_FERRAMENTA = [
    "javascript",
    "typescript",
    "node",
    "react",
    "nextjs",
    "java",
    "docker",
    "gcp",
    "google cloud",
    "python",
    "sql",
    "tailwind",
]

TERMOS_BUSCA = TERMOS_CARGO + TERMOS_FERRAMENTA

# TERMOS_POR_CICLO é o tamanho do BLOCO usado por ciclo, não o total de
# termos — main.py roda um bloco por vez em rodízio (ver
# _proximo_bloco_termos) e avança no ciclo seguinte, salvando a posição no
# jobs.db. Mantido em 10 para preservar o custo por ciclo.
TERMOS_POR_CICLO = 10

# Onde vaga HÍBRIDA ou PRESENCIAL é aceita, além de "Remoto" (que não é
# cidade, e sim a porta de entrada da regra de modalidade remota — ver
# _FLAGS_REMOTO em job.py). Vaga híbrida/presencial fora desta whitelist é
# rejeitada.
CIDADES = [
    "Remoto",
    "Florianópolis",
    "São José",
    "Palhoça",
]

# MEDIDO: "Software Engineering Intern @ Lisboa" e "Estágio em Desenvolvimento @ Madrid" reprovavam
# na localização, não no cargo — CIDADES acima é whitelist só de cidade
# brasileira, e a expansão de LOCATIONS_LINKEDIN pra Argentina/Chile (ver
# abaixo) passou a trazer vaga presencial/híbrida em Portugal/Espanha de
# vez em quando junto. Lista SEPARADA (não misturada em CIDADES, que
# continua só-Brasil de propósito — ver decisão registrada na criação do
# config_intl.py) com toggle próprio, pra dar pra ligar/desligar esse eixo
# sem mexer no resto do filtro. Canônica aqui porque config_intl.py já
# importa de config.py (não o contrário) — o pipeline internacional reusa
# essa mesma lista em vez de manter uma cópia (risco de divergir, mesmo
# motivo da unificação de _contem_termo/_tem_termo).
CIDADES_EUROPA_IBERICA = [
    "Portugal",
    "Lisboa",
    "Porto",
    "Braga",
    "Espanha",
    "España",
    "Spain",
    "Madrid",
    "Barcelona",
    "Valencia",
]

# Toggle independente do ATIVAR_EIXO_IBERICO de config_intl.py — são dois
# eixos diferentes (esse aqui é do pipeline BR/main.py, aquele é do
# pipeline internacional/main_intl.py), cada um com seu próprio liga/
# desliga, mesmo compartilhando a mesma lista de cidades acima.
#
# DESLIGADO: do mercado internacional, só interessa vaga remota — vaga
# presencial/híbrida em Lisboa/Madrid (o que esse eixo notifica, marcada
# "exploratória") não é o que o usuário quer. CIDADES_EUROPA_IBERICA
# continua definida (não precisa apagar) pra caso o eixo volte a ser
# ligado depois — só o toggle muda.
ATIVAR_EIXO_IBERICO_BR = False

# LinkedInScraper é a única fonte do pipeline BR que também alcança vaga
# fora do Brasil (as outras são portais brasileiros) — mas até aqui rodava
# só com location=Brasil fixo no código (scrapers/linkedin.py:88), então
# essa "porta pra fora" nunca era usada.
#
# Mercado "casa": busca modalidade completa (presencial/híbrida + remoto),
# porque o usuário mora aqui e vaga local de verdade interessa.
LOCATIONS_LINKEDIN = ["Brasil"]

# Mercados adicionais: só busca REMOTA (f_WT=2) — vaga presencial/híbrida
# num país onde o usuário não mora não serve, então nem faz sentido gastar
# a passada nacional ali (era puro desperdício: Argentina/Chile já rodavam
# as duas passadas antes, mas a nacional nunca batia em CIDADES mesmo,
# que é só cidade brasileira). Espanhol ou português — mesmo critério do
# pipeline internacional. Lista reaproveita exatamente os países já usados
# e testados ao vivo no endpoint do LinkedIn em config_intl.py
# (LOCATIONS_INTL) — evita arriscar nome de país nunca testado (grafia
# errada ou região que o LinkedIn não resolve como location de verdade,
# como já visto com "LATAM"/"Latin America").
LOCATIONS_LINKEDIN_REMOTO_APENAS = ["Argentina", "Chile", "México", "Colômbia", "Espanha", "Portugal"]

# MEDIDO: a passada nacional acima (location="Brasil") varre o país inteiro
# e só sobra o que bate em CIDADES depois do filtro — pra termo concorrido
# em SP/RJ/MG (a maioria), as 3 páginas (30 resultados) nunca chegam numa
# vaga de cidade menor da região alvo, porque o volume dos polos maiores
# ocupa tudo antes. Testado ao vivo: página 1 de "estágio em desenvolvimento" em
# Brasil inteiro veio 100% São Paulo/Curitiba/Brasília, nenhuma do
# região alvo. Busca ESPECÍFICA por cidade não depende de volume nacional —
# o próprio location= do LinkedIn já restringe o resultado à cidade, então
# funciona mesmo quando SP/RJ dominam o termo. "Remoto" (item de CIDADES)
# não é local de busca de verdade — sai da lista, já coberto pela passada
# remoto=True de LOCATIONS_LINKEDIN acima.
LOCATIONS_LINKEDIN_CIDADES_PRESENCIAL = [c for c in CIDADES if c != "Remoto"]

# Mercado que a vaga remota precisa aceitar pra contar, quando o texto de
# local DECLARA um escopo geográfico ("Remote — US only", "Remote — India").
# Ver Job.escopo_remoto/RegrasFiltro.mercados_remoto_aceitos em job.py — sem
# isso, uma vaga remota só pra outro país passava igual a uma remota de
# verdade pro Brasil. Vaga remota SEM escopo declarado no texto (a grande
# maioria) continua batendo normalmente, isso só filtra quando a fonte
# EXPLICITA um mercado incompatível.
#
# MEDIDO: Argentina/Chile/México/Colômbia ENTRAM nominalmente agora — a
# suposição de que "LATAM" cobria os quatro como guarda-chuva só valia
# enquanto extrair_escopo_remoto resolvia o texto pra "LATAM" literal.
# Depois que passou a reconhecer cidade (Buenos Aires/Santiago/Cidade do
# México/Bogotá — ver _CIDADES_MERCADO em job.py), o escopo passou a
# resolver pro PAÍS específico, não mais pro guarda-chuva — e o país
# específico nunca esteve nessa lista. Resultado: LOCATIONS_LINKEDIN_
# REMOTO_APENAS pagava o custo de buscar nesses 4 países e o filtro
# descartava tudo que a busca trazia de lá. "LATAM" continua na lista pra
# quando o texto disser isso literalmente (guarda-chuva de verdade, não
# substituto de nome de país). Portugal e Espanha entraram nominalmente
# pelo mesmo motivo, desde antes.
MERCADOS_REMOTO_ACEITOS = ["Brasil", "LATAM", "Argentina", "Chile", "México", "Colômbia", "Portugal", "Espanha"]

INTERVALO_MINUTOS = int(os.getenv("INTERVALO_MINUTOS", 180))

# Digest ranqueado (item 08): vaga com Job.pontuar_relevancia() >= este
# limiar notifica na hora (como sempre foi); abaixo disso, fica na fila do
# digest diário — ver _enviar_digest_diario em main.py.
#
# MEDIDO: rodei o score contra as ~305 vagas do jobs.db real que ainda
# batem as regras atuais. Distribuição: score 4 (2%), 5 (24%), 6 (67%),
# 7 (5%), 8 (2%) — nada em 9-10 na amostra (exige acertar praticamente
# todo sinal ao mesmo tempo: cargo forte + ferramenta + senioridade alvo +
# mercado confirmado). Limiar 7 deixa ~7% imediata e ~93% no digest — bate
# com o pedido ("vaga de score alto na hora, resto agrupado"); 6 deixava
# 74% imediata (pouca redução de ruído); 8 deixava só 2% (digest com
# praticamente tudo, quase nenhuma vaga "excelente" se destacando na hora).
LIMIAR_DIGEST_IMEDIATO = 7

# Hora UTC em que o digest diário dispara (uma vez por perfil, por dia —
# ver _enviar_digest_diario). 0 = meia-noite UTC = 21h em Brasília (UTC-3).
# O cron do workflow (0 */3 * * *) já passa por essa hora exata todo dia,
# então não precisa de agendamento à parte.
DIGEST_HORA_UTC = 0

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

# Caminho ancorado na RAIZ do projeto, não na pasta deste arquivo.
#
# MEDIDO: o commit b8227b0 ("Reorganiza raiz: ... -> core/") moveu este
# config.py da raiz pra core/. Como DB_PATH era relativo a __file__, o
# banco se mudou junto, em silêncio: data/jobs.db virou core/data/jobs.db.
# Efeito real, confirmado em disco e no jobradar.log:
#   - data/jobs.db (1.080 vagas, versionado) ficou órfão;
#   - core/data/jobs.db nasceu vazio, então iniciar_db() passou a abortar
#     por BancoVazioSuspeito em toda execução local;
#   - no GitHub Actions a pasta core/data/ não existe no repositório, então
#     o banco era recriado do zero a cada run — toda vaga virava "nova"
#     (renotificação a cada 3h), o rodízio de termos travava no offset 0
#     (só os 10 primeiros de 44 termos eram buscados), a fila do digest era
#     descartada e o heartbeat saía a cada ciclo em vez de 1x/dia;
#   - o passo "git add data/jobs.db" do workflow não via mudança nenhuma
#     ("Nada novo pra commitar"), então o estado nunca mais persistiu.
#
# _RAIZ_PROJETO sobe um nível a partir de core/, então o caminho deixa de
# depender de onde este arquivo mora — mover config.py de novo não move
# mais o banco junto. Coberto por tests/test_db_path.py, pra uma
# reorganização futura quebrar o teste em vez da produção.
#
# JOBRADAR_DB_PATH existe pra apontar um banco descartável em teste/
# experimento sem risco de escrever no banco real.
_RAIZ_PROJETO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.getenv("JOBRADAR_DB_PATH") or os.path.join(_RAIZ_PROJETO, "data", "jobs.db")
