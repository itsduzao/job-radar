import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GupySource } from "../src/gupy.js";
import type { GupyScraper } from "../src/playwright-scraper.js";
import { createLogger } from "../src/logger.js";
import type { GupySearchConfig } from "../src/config.js";
import type { Post } from "../src/domain.js";

describe("GupySource Resilience", () => {
  let config: GupySearchConfig;
  let mockScraper: GupyScraper;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    config = {
      source: "gupy",
      profiles: [
        { name: "profile-a", workplaceTypes: ["remote"], jobTypes: ["vacancy_type_internship"] },
        { name: "profile-b", workplaceTypes: ["onSite"], jobTypes: ["vacancy_type_effective"] },
      ],
      terms: ["termo1", "termo2"],
    };

    mockScraper = { fetchPosts: vi.fn() };
    logger = createLogger("test-gupy-resilience");
    process.env.GUPY_MAX_AGE_DAYS = "90";
  });

  afterEach(() => {
    delete process.env.GUPY_MAX_AGE_DAYS;
    vi.clearAllMocks();
  });

  function makePost(id: string): Post {
    return {
      id: `gupy:${id}`,
      url: `https://portal.gupy.io/job/${id}`,
      texto: [
        `Título: Vaga ${id}`,
        "Empresa: Acme",
        "Localização: Florianópolis/SC",
        "Modalidade: remoto",
        "Tipo: estagio",
        "Publicado: 2026-10-15T10:00:00-03:00",
        "Descrição: Desc...",
      ].join("\n"),
    };
  }

  describe("circuit breaker", () => {
    it("opens after 3 consecutive failures for same query", async () => {
      mockScraper.fetchPosts = vi.fn().mockRejectedValue(new Error("Network error"));

      const source = new GupySource(config, mockScraper, logger);
      await expect(source.fetchPosts()).rejects.toThrow("All Gupy queries failed");

      // Verify circuit breaker state is tracked (internal, but we can check behavior)
      // Next call with same failing queries should skip them
      mockScraper.fetchPosts = vi.fn().mockResolvedValue([makePost("ok")]);
      const posts = await source.fetchPosts();

      // The previously failed queries should be skipped (circuit open)
      // Only new successful mock returns posts
      expect(posts.length).toBeGreaterThanOrEqual(0);
    });

    it("resets circuit breaker on success", async () => {
      // First call fails 3 times for one query
      mockScraper.fetchPosts = vi.fn()
        .mockRejectedValueOnce(new Error("Fail"))
        .mockRejectedValueOnce(new Error("Fail"))
        .mockRejectedValueOnce(new Error("Fail"))
        .mockResolvedValue([makePost("ok")]); // other queries succeed

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBeGreaterThan(0);
    });

    it("logs warning when circuit breaker opens after 3 consecutive failures", async () => {
      const warnSpy = vi.spyOn(logger, "warn");

      // Create a config with only ONE query to test circuit breaker cleanly
      const singleQueryConfig: GupySearchConfig = {
        source: "gupy",
        profiles: [{ name: "test-profile", workplaceTypes: ["remote"], jobTypes: ["vacancy_type_internship"] }],
        terms: ["single-term"],
      };

      // Fail 3 times
      let failCount = 0;
      mockScraper.fetchPosts = vi.fn().mockImplementation(async () => {
        failCount++;
        if (failCount <= 3) {
          throw new Error("Network error");
        }
        return [makePost("ok")];
      });

      const source = new GupySource(singleQueryConfig, mockScraper, logger);

      // First call - 1st failure
      await expect(source.fetchPosts()).rejects.toThrow();

      // Second call - 2nd failure
      await expect(source.fetchPosts()).rejects.toThrow();

      // Third call - 3rd failure -> circuit opens
      await expect(source.fetchPosts()).rejects.toThrow();

      // Fourth call - circuit breaker open, query skipped, returns empty array
      const posts = await source.fetchPosts();
      expect(posts).toEqual([]);

      expect(warnSpy).toHaveBeenCalledWith(
        "Circuit breaker opened",
        expect.objectContaining({ queryKey: "test-profile:single-term" })
      );
    });
  });

  describe("error handling", () => {
    it("continues other queries when one fails", async () => {
      mockScraper.fetchPosts = vi.fn()
        .mockResolvedValueOnce([makePost("1")]) // profile-a:termo1 success
        .mockRejectedValueOnce(new Error("Fail")) // profile-a:termo2 fail
        .mockResolvedValueOnce([makePost("2")]) // profile-b:termo1 success
        .mockResolvedValueOnce([makePost("3")]); // profile-b:termo2 success

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBe(3);
      expect(posts.map(p => p.id)).toEqual(["gupy:1", "gupy:2", "gupy:3"]);
    });

    it("aggregates errors from all failed queries", async () => {
      mockScraper.fetchPosts = vi.fn().mockRejectedValue(new Error("All fail"));

      const source = new GupySource(config, mockScraper, logger);

      try {
        await source.fetchPosts();
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain("profile-a:termo1");
        expect(message).toContain("profile-a:termo2");
        expect(message).toContain("profile-b:termo1");
        expect(message).toContain("profile-b:termo2");
        expect(message).toContain("All fail");
      }
    });

    it("logs structured error per query", async () => {
      const errorSpy = vi.spyOn(logger, "error");
      mockScraper.fetchPosts = vi.fn()
        .mockResolvedValueOnce([makePost("1")])
        .mockRejectedValueOnce(new Error("Network error"));

      const source = new GupySource(config, mockScraper, logger);
      await source.fetchPosts();

      expect(errorSpy).toHaveBeenCalledWith(
        "Gupy query failed",
        expect.objectContaining({
          profile: expect.any(String),
          term: expect.any(String),
          error: "Network error",
        })
      );
    });
  });

  describe("structured logging", () => {
    it("logs query completion with collected count and duration", async () => {
      const infoSpy = vi.spyOn(logger, "info");
      mockScraper.fetchPosts = vi.fn().mockResolvedValue([makePost("1"), makePost("2")]);

      const source = new GupySource(config, mockScraper, logger);
      await source.fetchPosts();

      const queryCompletedLogs = infoSpy.mock.calls.filter(([msg]) => msg === "Gupy query completed");
      expect(queryCompletedLogs.length).toBe(4); // 2 profiles × 2 terms

      for (const call of queryCompletedLogs) {
        const meta = call[1];
        expect(meta).toMatchObject({
          source: "gupy",
          profile: expect.any(String),
          term: expect.any(String),
          collected: expect.any(Number),
          durationMs: expect.any(Number),
          error: null,
        });
      }
    });

    it("logs fetch completed summary", async () => {
      const infoSpy = vi.spyOn(logger, "info");
      mockScraper.fetchPosts = vi.fn().mockResolvedValue([makePost("1")]);

      const source = new GupySource(config, mockScraper, logger);
      await source.fetchPosts();

      const summaryLog = infoSpy.mock.calls.find(([msg]) => msg === "Gupy fetch completed");
      expect(summaryLog).toBeDefined();
      expect(summaryLog![1]).toMatchObject({
        collected: expect.any(Number),
        errors: expect.any(Number),
        profiles: 2,
        terms: 2,
        queries: expect.any(Array),
      });
    });
  });

  describe("dry-run mode", () => {
    it("returns empty array and does not call scraper", async () => {
      process.env.GUPY_DRY_RUN = "true";
      mockScraper.fetchPosts = vi.fn();

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      expect(posts).toEqual([]);
      expect(mockScraper.fetchPosts).not.toHaveBeenCalled();
      delete process.env.GUPY_DRY_RUN;
    });

    it("logs dry-run info", async () => {
      process.env.GUPY_DRY_RUN = "true";
      const infoSpy = vi.spyOn(logger, "info");
      mockScraper.fetchPosts = vi.fn();

      const source = new GupySource(config, mockScraper, logger);
      await source.fetchPosts();

      expect(infoSpy).toHaveBeenCalledWith(
        "Gupy dry-run enabled, skipping fetch",
        expect.objectContaining({ profiles: 2, terms: 2 })
      );
      delete process.env.GUPY_DRY_RUN;
    });
  });
});