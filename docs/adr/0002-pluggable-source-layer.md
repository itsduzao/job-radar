# Camada de fonte plugável (`Source`)

Modelamos cada fonte de vagas (LinkedIn primeiro) atrás de uma única interface `Source`, em vez de hardcodar o scraper. O objetivo declarado é adicionar mais sites (os boards de busca manual que o operador já consulta), então um contrato uniforme por fonte (coletar candidatos e normalizar para um formato comum) mantém a triagem e o digest independentes da origem desde o dia 1.
