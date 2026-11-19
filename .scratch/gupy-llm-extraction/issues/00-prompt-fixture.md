# 00: Prompt v1 + HTML Fixture Real

**What to build:** Criar prompt versionado + salvar HTML real de uma página Gupy para testes.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] `src/prompts/gupy-extraction-v1.txt` — prompt system + template user (conforme spec)
- [ ] Acessar `https://portal.gupy.io/job-search?term=estagio` no browser, salvar HTML completo da página em `test/fixtures/gupy/search-page-real.html`
- [ ] Extrair 3-5 cards individuais (`outerHTML`) e salvar em `test/fixtures/gupy/job-cards-real.json` (array de strings)
- [ ] Criar `test/fixtures/gupy/extracted-jobs-real.json` — JSON esperado (manual, baseado nos cards salvos)
- [ ] Documentar no ADR-0004 (próximo ticket) como capturar fixtures atualizados