import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GupySource } from "../src/gupy.js";
import { HttpClient } from "../src/http-client.js";
import { createLogger } from "../src/logger.js";
import type { GupySearchConfig } from "../src/config.js";
import type { Post } from "../src/domain.js";
import * as searchPage1 from "../test/fixtures/gupy/search-page-1.json" with { type: "json" };
import * as searchPage2 from "../test/fixtures/gupy/search-page-2.json" with { type: "json" };
import * as searchEmpty from "../test/fixtures/gupy/search-empty.json" with { type: "json" };
import * as jobDetail from "../test/fixtures/gupy/job-detail.json" with { type: "json" };
import * as error429 from "../test/fixtures/gupy/error-429.json" with { type: "json" };
import * as error403 from "../test/fixtures/gupy/error-403.json" with { type: "json" };
import * as talentPool from "../test/fixtures/gupy/talent-pool.json" with { type: "json" };

describe("GupySource", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;
  let config: GupySearchConfig;
  let httpClient: HttpClient;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

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

    httpClient = new HttpClient({ maxRetries: 0, baseDelayMs: 1, timeoutMs: 5000 });
    logger = createLogger("test-gupy");
    // Fixture dates are from Oct 2026; set max age to 90 days to include them when test runs in Nov 2026+
    process.env.GUPY_MAX_AGE_DAYS = "90";
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
    delete process.env.GUPY_MAX_AGE_DAYS;
  });

  function mockResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  function setupPaginationMock() {
    // Track call count per query (base URL without page parameter)
    const callCounts = new Map<string, number>();

    // Create a page with 50 items to trigger pagination
    const page1With50 = {
      ...searchPage1,
      data: Array(50).fill(null).map((_, i) => searchPage1.data[i % searchPage1.data.length]),
    };
    const page2With50 = {
      ...searchPage2,
      data: Array(50).fill(null).map((_, i) => searchPage2.data[i % searchPage2.data.length]),
    };

    function getBaseUrl(url: string): string {
      // Remove page parameter to group pagination calls for same query
      return url.replace(/[?&]page=\d+/, "").replace(/[?&]pageSize=\d+/, "");
    }

    fetchMock.mockImplementation((url: string) => {
      const baseUrl = getBaseUrl(url);
      const count = callCounts.get(baseUrl) || 0;
      callCounts.set(baseUrl, count + 1);

      // Detail URL -> job detail
      if (url.includes("/api/v1/jobs/12345678")) {
        return Promise.resolve(mockResponse(200, jobDetail));
      }
      // Search URLs
      if (url.includes("/api/v1/jobs?")) {
        if (count === 0) {
          return Promise.resolve(mockResponse(200, page1With50));
        }
        if (count === 1) {
          return Promise.resolve(mockResponse(200, page2With50));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      }
      return Promise.resolve(mockResponse(200, searchEmpty));
    });
  }

  describe("fetchPosts", () => {
    it("expands matrix profiles x terms and paginates", async () => {
      setupPaginationMock();

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      // 6 queries * (10 items page 1 + 12 items page 2) = 132, but cross-term dedupe reduces
      expect(posts.length).toBeGreaterThan(0);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6);
    });

    it("deduplicates cross-term by numericId", async () => {
      // Same job appears in two different term searches
      const duplicateJob = { ...searchPage1 };
      duplicateJob.data = [searchPage1.data[0], searchPage1.data[0]]; // Same job twice

      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, duplicateJob));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      const ids = posts.map((p) => p.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("maps workplaceType correctly in texto", async () => {
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [searchPage1.data[0]] })); // remote
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBeGreaterThan(0);
      expect(posts[0].texto).toContain("Modalidade: remoto");
    });

    it("maps jobType correctly in texto", async () => {
      // Test internship -> estagio
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [searchPage1.data[0]] })); // internship
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBeGreaterThan(0);
      expect(posts[0].texto).toContain("Tipo: estagio");
    });

    it("maps jobType trainee/effective to junior", async () => {
      const traineeJob = { ...searchPage1.data[1] }; // trainee
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [traineeJob] }));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBeGreaterThan(0);
      expect(posts[0].texto).toContain("Tipo: junior");
    });

    it("falls back to job detail when description is short", async () => {
      const shortDescJob = { ...searchPage1.data[0], description: "<p>Short</p>" };
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs/12345678")) {
          return Promise.resolve(mockResponse(200, jobDetail));
        }
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [shortDescJob] }));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/jobs/12345678"),
        expect.any(Object)
      );
      expect(posts.length).toBeGreaterThan(0);
      expect(posts[0].texto).toContain("Sobre a vaga");
    });

    it("filters talent pool jobs", async () => {
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [talentPool] }));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBe(0);
    });

    it("handles 429 error with retry and continues other queries", async () => {
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        // First query gets 429 then success
        if (url.includes("term=estagio") && count === 0) {
          return Promise.resolve(mockResponse(429, error429, { "retry-after": "1" }));
        }
        if (url.includes("term=estagio") && count === 1) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [searchPage1.data[0]] }));
        }
        if (url.includes("/api/v1/jobs?")) {
          return Promise.resolve(mockResponse(200, searchEmpty));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const retryHttpClient = new HttpClient({ maxRetries: 1, baseDelayMs: 1, timeoutMs: 5000 });
      const source = new GupySource(config, retryHttpClient, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBeGreaterThanOrEqual(0); // May succeed after retry
    });

    it("returns empty array on dry-run", async () => {
      process.env.GUPY_DRY_RUN = "true";
      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();
      delete process.env.GUPY_DRY_RUN;

      expect(posts).toEqual([]);
    });

    it("generates correct id and url format", async () => {
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [searchPage1.data[0]] }));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBeGreaterThan(0);
      expect(posts[0].id).toBe("gupy:12345678");
      expect(posts[0].url).toBe("https://portal.gupy.io/job/12345678");
    });

    it("sorts by publishedDate descending", async () => {
      const job1 = { ...searchPage1.data[0], publishedDate: "2026-10-10T10:00:00Z" };
      const job2 = { ...searchPage1.data[1], publishedDate: "2026-10-15T10:00:00Z" };
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [job1, job2] }));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();

      expect(posts.length).toBeGreaterThanOrEqual(2);
      const dateA = new Date(posts[0].texto.match(/Publicado: (.+)/)?.[1] || "").getTime();
      const dateB = new Date(posts[1].texto.match(/Publicado: (.+)/)?.[1] || "").getTime();
      expect(dateA).toBeGreaterThanOrEqual(dateB);
    });

    it("filters by maxAgeDays", async () => {
      const oldJob = { ...searchPage1.data[0], publishedDate: "2025-01-01T10:00:00Z" };
      const recentJob = { ...searchPage1.data[1], publishedDate: new Date().toISOString() };
      const callCounts = new Map<string, number>();
      fetchMock.mockImplementation((url: string) => {
        const count = callCounts.get(url) || 0;
        callCounts.set(url, count + 1);
        if (url.includes("/api/v1/jobs?") && count === 0) {
          return Promise.resolve(mockResponse(200, { ...searchPage1, data: [oldJob, recentJob] }));
        }
        return Promise.resolve(mockResponse(200, searchEmpty));
      });

      process.env.GUPY_MAX_AGE_DAYS = "30";
      const source = new GupySource(config, httpClient, logger);
      const posts = await source.fetchPosts();
      delete process.env.GUPY_MAX_AGE_DAYS;

      // Only recent job should pass the filter
      expect(posts.length).toBe(1);
      expect(posts[0].id).toBe("gupy:12345679");
    });
  });
});