# 05: Triagem das vagas via Gemini

**Status:** ready-for-agent

**What to build:** Usa o Gemini para decidir se um post corresponde aos critérios e, em caso positivo, extrair os campos da vaga. Critérios: tipo estágio ou júnior; área desenvolvimento de software (excluindo QA, DevOps, Mobile e dados); localização São José/SC, Florianópolis/SC ou remoto/home office; modalidade remoto, híbrido ou presencial. Ao fim deste ticket, posts irrelevantes são descartados com motivo, e posts relevantes viram vagas estruturadas.

**Blocked by:** 02 — Interface de fonte e forma normalizada de vaga

- [ ] Post que não corresponde aos critérios é descartado com um motivo curto
- [ ] Post que corresponde vira uma vaga estruturada (role, empresa, link, localização, tipo, área, modalidade)
- [ ] A chamada ao Gemini está atrás de uma interface (provider trocável)
