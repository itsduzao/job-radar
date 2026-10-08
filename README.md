# Job Radar

Varre posts do LinkedIn em busca de vagas de estágio e júnior em desenvolvimento de software, confirma a relevância com IA (Gemini) e envia um digest diário via Telegram. Roda grátis como cron job do GitHub Actions.

## Pré-requisitos

- Node.js >= 24
- Credenciais: cookie do LinkedIn, bot do Telegram e chave do Gemini

## Coletando as credenciais

### 1. `LI_COOKIE` (cookie de sessão do LinkedIn)

1. Logue no LinkedIn no navegador.
2. Abra DevTools (F12) → aba **Application** → **Cookies** → `https://www.linkedin.com`.
3. Copie o **valor** do cookie `li_at`.
4. Coloque em `.env` como `LI_COOKIE=...`.

> O cookie expira a cada poucas semanas. Quando o run começar a falhar com "cookie … expirado", repita este passo.

### 2. Bot do Telegram

1. Fale com [@BotFather](https://t.me/BotFather), use `/newbot` e copie o token → `TELEGRAM_BOT_TOKEN`.
2. Mande `/start` para o seu bot.
3. Pegue seu id em `https://api.telegram.org/bot<TOKEN>/getUpdates` → `result[].message.chat.id` → `TELEGRAM_CHAT_ID`.

### 3. Chave do Gemini

1. Vá em [Google AI Studio](https://aistudio.google.com) → **Get API key**.
2. Copie a chave → `GEMINI_API_KEY`.

## Rodando localmente

```bash
npx playwright install chromium
cp .env.example .env   # preencha os 4 valores
npm install
npm run start
```

## Deploy no GitHub Actions

1. Crie um repositório **público** no GitHub e faça `git push`.
2. Em **Settings → Secrets and variables → Actions**, adicione os 4 secrets:
   `LI_COOKIE`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `GEMINI_API_KEY`.
3. Vá em **Actions → run → Run workflow** para disparar manualmente.

O workflow roda diariamente às 09:00 BRT (cron `0 12 * * *` UTC) e commita de volta o estado de dedupe (`data/seen.json`).

## Notas

- O scraping do LinkedIn é *best-effort*: o DOM muda sem aviso e pode quebrar os seletores (ver `src/playwright-scraper.ts`).
- A fonte plugável (`Source`) permite adicionar outros sites depois (ver `docs/adr/0002-pluggable-source-layer.md`).
