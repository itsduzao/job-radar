# 06: Fonte LinkedIn (Playwright + cookie de sessão) end-to-end

**Status:** ready-for-agent

**What to build:** Implementa a fonte LinkedIn: varre a busca de posts pelo endpoint de busca de conteúdo, com Playwright autenticado por cookie de sessão, e alimenta o pipeline completo. Ao fim deste ticket, posts reais do LinkedIn fluem por triagem → dedupe → digest e chegam ao Telegram.

**Blocked by:** 03 — Digest de vagas no Telegram; 04 — Dedupe de vagas já vistas; 05 — Triagem das vagas via Gemini

- [ ] O run varre a busca do LinkedIn (query configurada) ordenada por data de publicação
- [ ] A autenticação usa Playwright com cookie de sessão injetado
- [ ] Posts reais passam por triagem, dedupe e digest, chegando ao Telegram
- [ ] Runs quebrados por cookie expirado falham com mensagem clara (não silenciosamente)
