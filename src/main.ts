import { loadConfig } from "./config.js";
import { run } from "./run.js";
import { StubSource } from "./source.js";
import { HttpTelegramClient, type TelegramClient } from "./telegram.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env file; secrets come from the environment (e.g. GitHub Actions)
}

const config = loadConfig();

let telegram: TelegramClient;
if (config.secrets.telegramBotToken && config.secrets.telegramChatId) {
  telegram = new HttpTelegramClient(
    config.secrets.telegramBotToken,
    config.secrets.telegramChatId,
  );
} else {
  console.warn("[job-radar] Telegram creds ausentes; digest desativado");
  telegram = { sendMessage: async () => {} };
}

run([new StubSource()], telegram).catch((err) => {
  console.error("[job-radar] run failed:", err);
  process.exitCode = 1;
});
