# 01: Scaffold do projeto e cron diário

**Status:** ready-for-agent

**What to build:** Repositório TypeScript inicializado e um workflow do GitHub Actions que roda o run diariamente às 09:00 BRT. Ao fim deste ticket, o operador consegue disparar um run manual e ver o pipeline (ainda vazio) executar e logar sem erro.

**Blocked by:** None (can start immediately)

- [ ] O run executa em TypeScript (Node) sem erro ao disparar manualmente
- [ ] O workflow roda no cron diário às 09:00 BRT
- [ ] A configuração de queries (a busca do LinkedIn) e os secrets (cookie de sessão, token e chat do Telegram, chave do Gemini) estão declarados com placeholders documentados
- [ ] O run pode ser disparado manualmente para debug
