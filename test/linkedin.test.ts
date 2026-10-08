import { describe, expect, it } from "vitest";
import { buildSearchUrl, LinkedInSource } from "../src/linkedin.js";
import type { LinkedInScraper } from "../src/linkedin.js";
import { isLoginUrl } from "../src/playwright-scraper.js";
import type { Query } from "../src/config.js";
import type { Post } from "../src/domain.js";

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

const post: Post = {
  id: "urn:li:activity:1",
  texto: "Estágio backend",
  url: "https://www.linkedin.com/feed/update/urn:li:activity:1",
};

describe("LinkedInSource", () => {
  it("devolve os posts do scraper", async () => {
    const scraper: LinkedInScraper = { fetchPosts: async () => [post] };
    const source = new LinkedInSource(query, "cookie", scraper);
    expect(await source.fetchPosts()).toEqual([post]);
  });
});

describe("isLoginUrl", () => {
  it("detecta páginas de login", () => {
    expect(isLoginUrl("https://www.linkedin.com/login?session_expired")).toBe(true);
    expect(isLoginUrl("https://www.linkedin.com/authwall")).toBe(true);
  });

  it("não marca a busca de conteúdo como login", () => {
    expect(isLoginUrl("https://www.linkedin.com/search/results/content/")).toBe(false);
  });
});
