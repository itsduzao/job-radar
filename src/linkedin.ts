import type { Query } from "./config.js";
import type { Post } from "./domain.js";
import type { Source } from "./source.js";

export interface RawPost {
  urn: string;
  texto: string;
  url: string;
}

export interface LinkedInScraper {
  fetchRawPosts(url: string, cookie: string): Promise<RawPost[]>;
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
    const raw = await this.scraper.fetchRawPosts(url, this.liCookie);
    if (raw.length === 0) {
      throw new Error(
        "nenhum post encontrado; cookie de sessão do LinkedIn pode estar expirado",
      );
    }
    return raw.map((r) => ({ id: r.urn, texto: r.texto, url: r.url }));
  }
}
