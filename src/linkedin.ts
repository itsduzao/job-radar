import type { Query } from "./config.js";
import type { Post } from "./domain.js";
import type { Source } from "./source.js";

export interface LinkedInScraper {
  fetchPosts(url: string, cookie: string): Promise<Post[]>;
}

export function buildSearchUrl(query: Query): string {
  const params = new URLSearchParams({
    keywords: query.keywords,
    origin: "FACETED_SEARCH",
    sortBy: JSON.stringify([query.sortBy]),
  });
  return `https://www.linkedin.com/search/results/content/?${params.toString()}`;
}

export class LinkedInSource implements Source {
  constructor(
    private readonly query: Query,
    private readonly liCookie: string,
    private readonly scraper: LinkedInScraper,
  ) {}

  async fetchPosts(): Promise<Post[]> {
    const url = buildSearchUrl(this.query);
    return this.scraper.fetchPosts(url, this.liCookie);
  }
}
