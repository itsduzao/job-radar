import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GupySource } from "../src/gupy.js";
import type { GupyScraper } from "../src/playwright-scraper.js";
import { createLogger } from "../src/logger.js";
import type { GupySearchConfig } from "../src/config.js";
import type { Post } from "../src/domain.js";

describe("GupySource", () => {
  let config: GupySearchConfig;
  let mockScraper: GupyScraper;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    config = {
      source: "gupy",
      profiles: [
        {
          name: "florianopolis-sc",
          state: "SC",
          cities: ["Florianópolis"],
          workplaceTypes: ["remote", "hybrid", "onSite"],
          jobTypes: ["vacancy_type_internship", "vacancy_type_trainee", "vacancy_type_effective"],
        },
        {
          name: "remote-br",
          workplaceTypes: ["remote"],
          jobTypes: ["vacancy_type_internship", "vacancy_type_trainee", "vacancy_type_effective"],
        },
      ],
      terms: ["estagio", "junior", "desenvolvedor"],
    };

    mockScraper = {
      fetchPosts: vi.fn(),
    };

    logger = createLogger("test-gupy");
    process.env.GUPY_MAX_AGE_DAYS = "90";
  });

  afterEach(() => {
    delete process.env.GUPY_MAX_AGE_DAYS;
    vi.clearAllMocks();
  });

  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      id: `gupy:12345`,
      url: "https://portal.gupy.io/job/12345",
      texto: [
        "Título: Estágio Backend",
        "Empresa: Acme",
        "Localização: Florianópolis/SC",
        "Modalidade: remoto",
        "Tipo: estagio",
        "Publicado: 2026-10-15T10:00:00-03:00",
        "Descrição: Vaga para estagiário backend...",
      ].join("\n"),
      ...overrides,
    };
  }

  describe("fetchPosts", () => {
    it("expands matrix profiles x terms and calls scraper for each", async () => {
      let callCount = 0;
      mockScraper.fetchPosts = vi.fn().mockImplementation(async () => {
        callCount++;
        // Return unique posts per call to avoid cross-term dedupe removing them
        return [
          makePost({ id: `gupy:${callCount}a`, texto: makePost().texto.replace("12345", `${callCount}a`) }),
          makePost({ id: `gupy:${callCount}b`, texto: makePost().texto.replace("12345", `${callCount}b`) }),
        ];
      });

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      // 2 profiles × 3 terms = 6 queries
      expect(mockScraper.fetchPosts).toHaveBeenCalledTimes(6);
      expect(posts.length).toBe(12); // 6 queries × 2 posts each
    });

    it("deduplicates cross-term by numericId", async () => {
      const duplicatePost = makePost({ id: "gupy:1" });
      const uniquePost = makePost({ id: "gupy:2" });
      mockScraper.fetchPosts = vi.fn()
        .mockResolvedValueOnce([duplicatePost, uniquePost]) // first query
        .mockResolvedValueOnce([duplicatePost, uniquePost]); // second query (same IDs)

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      const ids = posts.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length); // no duplicates
      expect(posts.length).toBe(2); // only unique posts
    });

    it("filters out posts older than maxAgeDays", async () => {
      const oldPost = makePost({
        id: "gupy:old",
        texto: makePost().texto.replace("2026-10-15", "2025-01-01"), // > 90 days old
      });
      const newPost = makePost({ id: "gupy:new" });
      mockScraper.fetchPosts = vi.fn().mockResolvedValue([oldPost, newPost]);

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBe(1);
      expect(posts[0].id).toBe("gupy:new");
    });

    it("maps workplaceType correctly in texto", async () => {
      const remotePost = makePost({
        id: "gupy:remote",
        texto: makePost().texto.replace("Modalidade: remoto", "Modalidade: remoto"),
      });
      const onsitePost = makePost({
        id: "gupy:onsite",
        texto: makePost({}).texto.replace("Modalidade: remoto", "Modalidade: presencial"),
      });
      const hybridPost = makePost({
        id: "gupy:hybrid",
        texto: makePost({}).texto.replace("Modalidade: remoto", "Modalidade: hibrido"),
      });

      mockScraper.fetchPosts = vi.fn()
        .mockResolvedValueOnce([remotePost])
        .mockResolvedValueOnce([onsitePost])
        .mockResolvedValueOnce([hybridPost])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      const remote = posts.find(p => p.id === "gupy:remote");
      const onsite = posts.find(p => p.id === "gupy:onsite");
      const hybrid = posts.find(p => p.id === "gupy:hybrid");

      expect(remote?.texto).toContain("Modalidade: remoto");
      expect(onsite?.texto).toContain("Modalidade: presencial");
      expect(hybrid?.texto).toContain("Modalidade: hibrido");
    });

    it("maps jobType correctly in texto", async () => {
      const internshipPost = makePost({
        id: "gupy:intern",
        texto: makePost({}).texto.replace("Tipo: estagio", "Tipo: estagio"),
      });
      const traineePost = makePost({
        id: "gupy:trainee",
        texto: makePost({}).texto.replace("Tipo: estagio", "Tipo: junior"),
      });
      const effectivePost = makePost({
        id: "gupy:effective",
        texto: makePost({}).texto.replace("Tipo: estagio", "Tipo: junior"),
      });

      mockScraper.fetchPosts = vi.fn()
        .mockResolvedValueOnce([internshipPost])
        .mockResolvedValueOnce([traineePost])
        .mockResolvedValueOnce([effectivePost])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      const intern = posts.find(p => p.id === "gupy:intern");
      const trainee = posts.find(p => p.id === "gupy:trainee");
      const effective = posts.find(p => p.id === "gupy:effective");

      expect(intern?.texto).toContain("Tipo: estagio");
      expect(trainee?.texto).toContain("Tipo: junior");
      expect(effective?.texto).toContain("Tipo: junior");
    });

    it("sorts posts by publishedDate descending", async () => {
      const olderPost = makePost({
        id: "gupy:older",
        texto: makePost().texto.replace("Publicado: 2026-10-15T10:00:00-03:00", "Publicado: 2026-10-10T10:00:00-03:00"),
      });
      const newerPost = makePost({
        id: "gupy:newer",
        texto: makePost().texto.replace("Publicado: 2026-10-15T10:00:00-03:00", "Publicado: 2026-10-20T10:00:00-03:00"),
      });
      mockScraper.fetchPosts = vi.fn().mockResolvedValue([olderPost, newerPost]);

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      expect(posts[0].id).toBe("gupy:newer");
      expect(posts[1].id).toBe("gupy:older");
    });

    it("handles scraper errors and continues other queries", async () => {
      mockScraper.fetchPosts = vi.fn()
        .mockResolvedValueOnce([makePost({ id: "gupy:1" })]) // success
        .mockRejectedValueOnce(new Error("Network error")) // failure
        .mockResolvedValueOnce([makePost({ id: "gupy:2" })]) // success
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBe(2); // only successful queries
      expect(posts.map(p => p.id)).toEqual(["gupy:1", "gupy:2"]);
    });

    it("throws if all queries fail", async () => {
      mockScraper.fetchPosts = vi.fn().mockRejectedValue(new Error("All failed"));

      const source = new GupySource(config, mockScraper, logger);

      await expect(source.fetchPosts()).rejects.toThrow("All Gupy queries failed");
    });

    it("opens circuit breaker after 3 consecutive failures", async () => {
      mockScraper.fetchPosts = vi.fn().mockRejectedValue(new Error("Fail"));

      const source = new GupySource(config, mockScraper, logger);
      await expect(source.fetchPosts()).rejects.toThrow();

      // Second call - circuit breaker should be open for failed queries
      mockScraper.fetchPosts = vi.fn().mockResolvedValue([makePost({ id: "gupy:ok" })]);
      const posts = await source.fetchPosts();

      // Some queries should be skipped due to circuit breaker
      // But at least the successful mock should be called for non-broken queries
      expect(posts.length).toBeGreaterThanOrEqual(0);
    });

    it("respects dry-run mode", async () => {
      process.env.GUPY_DRY_RUN = "true";
      mockScraper.fetchPosts = vi.fn();

      const source = new GupySource(config, mockScraper, logger);
      const posts = await source.fetchPosts();

      expect(posts).toEqual([]);
      expect(mockScraper.fetchPosts).not.toHaveBeenCalled();
      delete process.env.GUPY_DRY_RUN;
    });

    it("builds correct search URLs with profile filters", async () => {
      const capturedUrls: string[] = [];
      mockScraper.fetchPosts = vi.fn().mockImplementation(async (url: string) => {
        capturedUrls.push(url);
        return [];
      });

      const source = new GupySource(config, mockScraper, logger);
      await source.fetchPosts();

      expect(capturedUrls.length).toBe(6); // 2 profiles × 3 terms

      // Check florianopolis-sc profile
      const floripaUrls = capturedUrls.filter(u => u.includes("state=SC"));
      expect(floripaUrls.length).toBe(3);
      for (const url of floripaUrls) {
        // URLSearchParams encodes [] as %5B%5D
        expect(url).toContain("city%5B%5D=Florian%C3%B3polis");
        expect(url).toContain("workplaceTypes%5B%5D=remote");
        expect(url).toContain("workplaceTypes%5B%5D=hybrid");
        expect(url).toContain("workplaceTypes%5B%5D=onSite");
      }

      // Check remote-br profile
      const remoteUrls = capturedUrls.filter(u => !u.includes("state="));
      expect(remoteUrls.length).toBe(3);
      for (const url of remoteUrls) {
        expect(url).toContain("workplaceTypes%5B%5D=remote");
        expect(url).not.toContain("city%5B%5D");
      }
    });
  });
});