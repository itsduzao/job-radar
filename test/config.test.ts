import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const LINKEDIN_QUERY =
  'vaga (estagio OR junior OR jr) (desenvolvedor OR ti OR tecnologia) (florianopolis OR florianópolis OR "sao jose" OR "são josé" OR remoto OR "home office") NOT Netvagas';

describe("loadConfig", () => {
  it("loads the agreed LinkedIn query", () => {
    const config = loadConfig({});
    expect(config.queries).toHaveLength(1);
    expect(config.queries[0]).toEqual({
      source: "linkedin",
      sortBy: "date_posted",
      keywords: LINKEDIN_QUERY,
    });
  });

  it("reads secrets from the environment", () => {
    const config = loadConfig({
      LI_COOKIE: "cookie",
      TELEGRAM_BOT_TOKEN: "bot",
      TELEGRAM_CHAT_ID: "chat",
      GEMINI_API_KEY: "key",
    });
    expect(config.secrets).toEqual({
      liCookie: "cookie",
      telegramBotToken: "bot",
      telegramChatId: "chat",
      geminiApiKey: "key",
    });
  });
});
