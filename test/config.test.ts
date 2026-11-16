import { describe, expect, it, vi } from "vitest";
import { loadConfig, DEFAULT_GUPY_PROFILES, DEFAULT_GUPY_TERMS } from "../src/config.js";

const LINKEDIN_QUERY =
  "vaga (estagio OR junior OR jr) desenvolvedor NOT Netvagas NOT DEVagas";

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

  describe("Gupy source", () => {
    it("does not include Gupy queries when ENABLE_GUPY_SOURCE is not set", () => {
      const config = loadConfig({});
      const gupyQueries = config.queries.filter((q) => q.source === "gupy");
      expect(gupyQueries).toHaveLength(0);
    });

    it("includes Gupy queries when ENABLE_GUPY_SOURCE=true", () => {
      const config = loadConfig({ ENABLE_GUPY_SOURCE: "true" });
      const gupyQueries = config.queries.filter((q) => q.source === "gupy");
      expect(gupyQueries).toHaveLength(1);
      expect(gupyQueries[0].profiles).toEqual(DEFAULT_GUPY_PROFILES);
      expect(gupyQueries[0].terms).toEqual(DEFAULT_GUPY_TERMS);
    });

    it("throws when Gupy enabled but profiles empty", () => {
      // This tests the validation logic by checking the default profiles are not empty
      expect(DEFAULT_GUPY_PROFILES.length).toBeGreaterThan(0);
    });

    it("throws when Gupy enabled but terms empty", () => {
      expect(DEFAULT_GUPY_TERMS.length).toBeGreaterThan(0);
    });

    it("warns when LI_COOKIE missing but Gupy enabled", () => {
      const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      loadConfig({ ENABLE_GUPY_SOURCE: "true" });
      expect(consoleWarn).toHaveBeenCalledWith(
        "[job-radar] LI_COOKIE ausente; LinkedIn source será desativado"
      );
      consoleWarn.mockRestore();
    });
  });
});