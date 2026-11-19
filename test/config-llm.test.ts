import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const LLM_DEFAULTS = {
  enabled: false,
  model: "gemini-3.5-flash-lite",
  maxOutputTokens: 8000,
  batchSize: 10,
};

describe("loadConfig Gupy LLM extraction", () => {
  it("defaults to disabled with the documented model, token and batch values", () => {
    const config = loadConfig({});
    expect(config.gupyLlm).toEqual(LLM_DEFAULTS);
  });

  it("keeps the existing queries and secrets shape untouched", () => {
    const config = loadConfig({ GEMINI_API_KEY: "key" });
    expect(config.queries).toHaveLength(1);
    expect(config.secrets.geminiApiKey).toBe("key");
  });

  it("enables extraction and reads overrides when the flag is true", () => {
    const config = loadConfig({
      GUPY_USE_LLM_EXTRACTION: "true",
      GEMINI_API_KEY: "key",
      GEMINI_EXTRACTION_MODEL: "gemini-2.5-flash",
      GEMINI_EXTRACTION_MAX_TOKENS: "4096",
      GEMINI_EXTRACTION_BATCH_SIZE: "5",
    });
    expect(config.gupyLlm).toEqual({
      enabled: true,
      model: "gemini-2.5-flash",
      maxOutputTokens: 4096,
      batchSize: 5,
    });
  });

  it("stays disabled for values other than the literal true", () => {
    for (const value of ["1", "TRUE", "yes", "false"]) {
      const config = loadConfig({ GUPY_USE_LLM_EXTRACTION: value, GEMINI_API_KEY: "key" });
      expect(config.gupyLlm.enabled).toBe(false);
    }
  });

  it("throws when the flag is true and GEMINI_API_KEY is missing", () => {
    expect(() => loadConfig({ GUPY_USE_LLM_EXTRACTION: "true" })).toThrow(
      /GEMINI_API_KEY/
    );
  });

  it("throws when the flag is true and GEMINI_API_KEY is empty", () => {
    expect(() =>
      loadConfig({ GUPY_USE_LLM_EXTRACTION: "true", GEMINI_API_KEY: "   " })
    ).toThrow(/GEMINI_API_KEY/);
  });

  it("does not require GEMINI_API_KEY when the flag is off", () => {
    expect(() => loadConfig({ GUPY_USE_LLM_EXTRACTION: "false" })).not.toThrow();
    expect(() => loadConfig({})).not.toThrow();
  });

  it.each([
    ["zero", "0"],
    ["negative", "-5"],
    ["non numeric", "abc"],
    ["fractional", "10.5"],
    ["empty", ""],
  ])("falls back to defaults for %s numeric values", (_label, value) => {
    const config = loadConfig({
      GUPY_USE_LLM_EXTRACTION: "true",
      GEMINI_API_KEY: "key",
      GEMINI_EXTRACTION_MAX_TOKENS: value,
      GEMINI_EXTRACTION_BATCH_SIZE: value,
    });
    expect(config.gupyLlm.maxOutputTokens).toBe(LLM_DEFAULTS.maxOutputTokens);
    expect(config.gupyLlm.batchSize).toBe(LLM_DEFAULTS.batchSize);
  });
});
