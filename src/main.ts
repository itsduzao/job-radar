import { loadConfig } from "./config.js";
import { run } from "./run.js";
import { FileSeenStore } from "./seen.js";
import { StubSource } from "./source.js";
import { HttpTelegramClient, type TelegramClient } from "./telegram.js";
import {
  GeminiTriageProvider,
  type TriageProvider,
  type TriageResult,
} from "./triage.js";

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

let triageProvider: TriageProvider;
if (config.secrets.geminiApiKey) {
  triageProvider = new GeminiTriageProvider(config.secrets.geminiApiKey);
} else {
  console.warn("[job-radar] GEMINI_API_KEY ausente; triagem desativada");
  triageProvider = {
    async triagePost(): Promise<TriageResult> {
      return { relevante: false, motivo: "chave do Gemini ausente" };
    },
  };
}

run({
  sources: [new StubSource()],
  telegram,
  seen: new FileSeenStore("data/seen.json"),
  triageProvider,
}).catch((err) => {
  console.error("[job-radar] run failed:", err);
  process.exitCode = 1;
});
