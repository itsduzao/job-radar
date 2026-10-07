import { describe, expect, it } from "vitest";
import { buildSearchUrl, LinkedInSource } from "../src/linkedin.js";
import type { LinkedInScraper, RawPost } from "../src/linkedin.js";
import type { Query } from "../src/config.js";

const query: Query = {
  source: "linkedin",
  sortBy: "date_posted",
  keywords: "vaga estagio (desenvolvedor OR ti)",
};

describe("buildSearchUrl", () => {
  it("monta a URL da busca com keywords, sortBy e origin", () => {
    const parsed = new URL(buildSearchUrl(query));
    expect(parsed.origin + parsed.pathname).toBe(
      "https://www.linkedin.com/search/results/content/",
    );
    expect(parsed.searchParams.get("keywords")).toBe("vaga estagio (desenvolvedor OR ti)");
    expect(parsed.searchParams.get("sortBy")).toBe('["date_posted"]');
    expect(parsed.searchParams.get("origin")).toBe("FACETED_SEARCH");
  });
});

const rawPost: RawPost = {
  urn: "urn:li:activity:1",
  texto: "Estágio backend",
  url: "https://www.linkedin.com/feed/update/urn:li:activity:1",
};

describe("LinkedInSource", () => {
  it("mapeia posts crus para Post[]", async () => {
    const scraper: LinkedInScraper = { fetchRawPosts: async () => [rawPost] };
    const source = new LinkedInSource(query, "cookie", scraper);
    const posts = await source.fetchPosts();
    expect(posts).toEqual([
      {
        id: "urn:li:activity:1",
        texto: "Estágio backend",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:1",
      },
    ]);
  });

  it("lança erro claro quando não há posts (cookie expirado)", async () => {
    const scraper: LinkedInScraper = { fetchRawPosts: async () => [] };
    const source = new LinkedInSource(query, "cookie", scraper);
    await expect(source.fetchPosts()).rejects.toThrow(/cookie de sessão/);
  });
});
