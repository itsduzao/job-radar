import { GupyPlaywrightScraper, type GupyScraper } from "./playwright-scraper.js";
import type { Logger } from "./logger.js";
import type { GupySearchConfig, GupySearchProfile } from "./config.js";
import type { Source } from "./source.js";
import type { Post } from "./domain.js";

const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_AGE_DAYS = 30;
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000; // 5 minutes

interface CircuitBreakerState {
  failures: number;
  openUntil: number;
}

export class GupySource implements Source {
  private readonly circuitBreaker = new Map<string, CircuitBreakerState>();

  constructor(
    private readonly config: GupySearchConfig,
    private readonly scraper: GupyScraper,
    private readonly logger: Logger
  ) {}

  async fetchPosts(): Promise<Post[]> {
    if (process.env.GUPY_DRY_RUN === "true") {
      this.logger.info("Gupy dry-run enabled, skipping fetch", {
        profiles: this.config.profiles.length,
        terms: this.config.terms.length,
      });
      return [];
    }

    const maxPages = parseInt(process.env.GUPY_MAX_PAGES ?? "", 10) || DEFAULT_MAX_PAGES;
    const maxAgeDays = parseInt(process.env.GUPY_MAX_AGE_DAYS ?? "", 10) || DEFAULT_MAX_AGE_DAYS;
    const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

    const allPosts: Post[] = [];
    const seenIds = new Set<string>();
    const errors: Array<{ profile: string; term: string; error: Error }> = [];
    const queryResults: Array<{
      profile: string;
      term: string;
      collected: number;
      durationMs: number;
      error: Error | null;
    }> = [];

    for (const profile of this.config.profiles) {
      for (const term of this.config.terms) {
        const queryKey = `${profile.name}:${term}`;
        const startTime = Date.now();
        let collected = 0;
        let error: Error | null = null;

        // Check circuit breaker
        const cbState = this.circuitBreaker.get(queryKey);
        if (cbState && cbState.openUntil > Date.now()) {
          this.logger.warn("Circuit breaker open, skipping query", { profile: profile.name, term });
          queryResults.push({ profile: profile.name, term, collected: 0, durationMs: 0, error: new Error("Circuit breaker open") });
          continue;
        }

        try {
          const url = this.buildSearchUrl(profile, term);
          const posts = await this.scraper.fetchPosts(url);

          // Filter by age and deduplicate
          const filteredPosts = posts.filter(post => {
            if (seenIds.has(post.id)) return false;
            const publishedDate = this.extractPublishedDate(post.texto);
            if (publishedDate > 0 && publishedDate < cutoffTime) return false;
            seenIds.add(post.id);
            return true;
          });

          collected = filteredPosts.length;
          allPosts.push(...filteredPosts);
          this.circuitBreaker.delete(queryKey);
        } catch (err) {
          error = err as Error;
          this.logger.error("Gupy query failed", {
            profile: profile.name,
            term,
            error: error.message,
          });
          errors.push({ profile: profile.name, term, error });
          this.updateCircuitBreaker(queryKey);
        }

        const durationMs = Date.now() - startTime;
        queryResults.push({ profile: profile.name, term, collected, durationMs, error });

        this.logger.info("Gupy query completed", {
          source: "gupy",
          profile: profile.name,
          term,
          collected,
          durationMs,
          error: error?.message ?? null,
        });
      }
    }

    if (errors.length > 0 && errors.length === this.config.profiles.length * this.config.terms.length) {
      throw new Error(
        `All Gupy queries failed: ${errors.map((e) => `${e.profile}:${e.term} - ${e.error.message}`).join("; ")}`
      );
    }

    allPosts.sort((a, b) => {
      const dateA = this.extractPublishedDate(a.texto);
      const dateB = this.extractPublishedDate(b.texto);
      return dateB - dateA;
    });

    this.logger.info("Gupy fetch completed", {
      collected: allPosts.length,
      errors: errors.length,
      profiles: this.config.profiles.length,
      terms: this.config.terms.length,
      queries: queryResults.map((q) => ({
        profile: q.profile,
        term: q.term,
        collected: q.collected,
        durationMs: q.durationMs,
      })),
    });

    return allPosts;
  }

  private updateCircuitBreaker(queryKey: string): void {
    const now = Date.now();
    const state = this.circuitBreaker.get(queryKey) ?? { failures: 0, openUntil: 0 };
    state.failures += 1;
    if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
      state.openUntil = now + CIRCUIT_BREAKER_RESET_MS;
      this.logger.warn("Circuit breaker opened", { queryKey, openUntil: new Date(state.openUntil).toISOString() });
    }
    this.circuitBreaker.set(queryKey, state);
  }

  private buildSearchUrl(profile: GupySearchProfile, term: string): string {
    const params = new URLSearchParams();

    if (profile.state) {
      params.set("state", profile.state);
    }
    if (profile.cities && profile.cities.length > 0) {
      for (const city of profile.cities) {
        params.append("city[]", city);
      }
    }
    if (profile.workplaceTypes && profile.workplaceTypes.length > 0) {
      for (const wt of profile.workplaceTypes) {
        params.append("workplaceTypes[]", wt);
      }
    }
    if (profile.jobTypes && profile.jobTypes.length > 0) {
      for (const jt of profile.jobTypes) {
        params.append("jobTypes[]", jt);
      }
    }

    const query = params.toString();
    return `https://portal.gupy.io/job-search/term=${encodeURIComponent(term)}${
      query ? `?${query}` : ""
    }`;
  }

  private extractPublishedDate(texto: string): number {
    const match = texto.match(/Publicado: (.+)/);
    if (match) {
      return Date.parse(match[1]);
    }
    return 0;
  }
}