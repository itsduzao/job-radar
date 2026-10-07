# 04: Dedupe de vagas já vistas

**Status:** ready-for-agent

**What to build:** Garante que um post já visto não seja re-notificado em runs futuros, usando o identificador do post como chave num estado versionado no repo. Ao fim deste ticket, rodar o run duas vezes sem dados novos não envia nada na segunda.

**Blocked by:** 03 — Digest de vagas no Telegram

- [ ] Cada post tem um identificador estável (URN) usado como chave de dedupe
- [ ] O estado de vagas já vistas é persistido e versionado no repo
- [ ] Um segundo run sem posts novos envia zero vagas
