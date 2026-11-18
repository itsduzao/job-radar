import { loadConfig, type LinkedInQuery, type GupySearchConfig } from "./config.js";
import { LinkedInSource } from "./linkedin.js";
import { GupySource } from "./gupy.js";
import { GeminiExtractor } from "./gemini-extractor.js";
import { PlaywrightScraper, GupyPlaywrightScraper } from "./playwright-scraper.js";
import { run } from "./run.js";
import { FileSeenStore } from "./seen.js";
import { StubSource } from "./source.js";
import type { Source } from "./source.js";
import { HttpTelegramClient, type TelegramClient } from "./telegram.js";
import {
  GeminiTriageProvider,
  type TriageProvider,
  type TriageResult,
} from "./triage.js";
import { createLogger } from "./logger.js";

try {
  process.loadEnvFile?.(".env");
} catch {
  // no .env file; secrets come from the environment (e.g. GitHub Actions)
}

const config = loadConfig();

const logger = createLogger("main");

let telegram: TelegramClient;
if (config.secrets.telegramBotToken && config.secrets.telegramChatId) {
  telegram = new HttpTelegramClient(
    config.secrets.telegramBotToken,
    config.secrets.telegramChatId,
  );
} else {
  logger.warn("Telegram creds ausentes; digest desativado");
  telegram = { sendMessage: async () => {} };
}

let triageProvider: TriageProvider;
if (config.secrets.geminiApiKey) {
  triageProvider = new GeminiTriageProvider(config.secrets.geminiApiKey);
} else {
  logger.warn("GEMINI_API_KEY ausente; triagem desativada");
  triageProvider = {
    async triagePost(): Promise<TriageResult> {
      return { relevante: false, motivo: "chave do Gemini ausente" };
    },
  };
}

let sources: Source[] = [];
const liCookie = config.secrets.liCookie;
const linkedInQueries = config.queries.filter(
  (q): q is LinkedInQuery => q.source === "linkedin"
);
if (liCookie && linkedInQueries.length > 0) {
  sources.push(
    ...linkedInQueries.map(
      (query) => new LinkedInSource(query, liCookie, new PlaywrightScraper()),
    )
  );
} else {
  logger.warn("LI_COOKIE ausente ou sem queries LinkedIn; LinkedIn source desativado");
}

const gupyQueries = config.queries.filter(
  (q): q is GupySearchConfig => q.source === "gupy"
);
const dryRun = process.env.GUPY_DRY_RUN === "true";

logger.info("llm_extraction", {
  enabled: config.gupyLlm.enabled,
  model: config.gupyLlm.model,
  batchSize: config.gupyLlm.batchSize,
});

if (gupyQueries.length > 0) {
  let gupyScraper: GupyPlaywrightScraper;
  if (config.gupyLlm.enabled) {
    const extractor = new GeminiExtractor(
      config.secrets.geminiApiKey!,
      config.gupyLlm.model,
      logger.child({ source: "gupy-llm" }),
    );
    gupyScraper = new GupyPlaywrightScraper(
      extractor,
      true,
      logger.child({ source: "gupy" }),
    );
  } else {
    gupyScraper = new GupyPlaywrightScraper(
      undefined,
      false,
      logger.child({ source: "gupy" }),
    );
  }

  for (const query of gupyQueries) {
    sources.push(
      new GupySource(query, gupyScraper, logger.child({ source: "gupy", profile: query.profiles[0]?.name }))
    );
  }
}

logger.info("Sources configured", {
  enabled: sources.length,
  linkedin: linkedInQueries.length,
  gupy: gupyQueries.length,
  dryRun,
});

run({
  sources,
  telegram,
  seen: new FileSeenStore("data/seen.json"),
  triageProvider,
}).catch((err) => {
  logger.error("Run failed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
