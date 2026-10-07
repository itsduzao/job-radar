# 02: Interface de fonte e forma normalizada de vaga (com fonte stub)

**Status:** ready-for-agent

**What to build:** Define a abstração de fonte (cada origem de vaga atrás de uma interface comum) e a forma normalizada de uma vaga. Entrega uma fonte stub que devolve uma vaga fixa, provando que o pipeline consegue obter uma vaga normalizada a partir de uma fonte.

**Blocked by:** 01 — Scaffold do projeto e cron diário

- [ ] Existe um contrato de fonte que devolve candidatos (posts brutos) normalizados para uma forma comum
- [ ] A forma normalizada de vaga carrega os campos: role, empresa, link, localização, tipo, área, modalidade
- [ ] Uma fonte stub devolve pelo menos uma vaga fixa e o run a consome
