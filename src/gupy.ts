import { HttpClient, HttpError } from "./http-client.js";
import type { Logger } from "./logger.js";
import type { GupySearchConfig, GupySearchProfile } from "./config.js";
import type { Source } from "./source.js";
import type { Post } from "./domain.js";

interface GupyJob {
  id: number;
  name: string;
  companyName: string;
  city: string;
  state: string;
  workplaceType: string;
  jobType: string;
  publishedDate: string;
  description: string;
  isTalentPool?: boolean;
}

interface GupySearchResponse {
  data: GupyJob[];
  page: number;
  pageSize: number;
  totalPages: number;
}

const WORKPLACE_TYPE_MAP: Record<string, string> = {
  remote: "remoto",
  onSite: "presencial",
  hybrid: "hibrido",
};

const JOB_TYPE_MAP: Record<string, string> = {
  vacancy_type_internship: "estagio",
  vacancy_type_trainee: "junior",
  vacancy_type_effective: "junior",
};

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_AGE_DAYS = 30;
const MIN_DESCRIPTION_LENGTH = 200;
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
    private readonly httpClient: HttpClient,
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
    const seenIds = new Set<number>();
    const errors: Array<{ profile: string; term: string; error: Error }> = [];
    const queryResults: Array<{
      profile: string;
      term: string;
      collected: number;
      durationMs: number;
      rateLimitRemaining: number | null;
      error: Error | null;
    }> = [];

    for (const profile of this.config.profiles) {
      for (const term of this.config.terms) {
        const queryKey = `${profile.name}:${term}`;
        const startTime = Date.now();
        let collected = 0;
        let rateLimitRemaining: number | null = null;
        let error: Error | null = null;

        // Check circuit breaker
        const cbState = this.circuitBreaker.get(queryKey);
        if (cbState && cbState.openUntil > Date.now()) {
          this.logger.warn("Circuit breaker open, skipping query", { profile: profile.name, term });
          queryResults.push({ profile: profile.name, term, collected: 0, durationMs: 0, rateLimitRemaining: null, error: new Error("Circuit breaker open") });
          continue;
        }

        try {
          const posts = await this.fetchPostsForProfileAndTerm(profile, term, maxPages, cutoffTime, seenIds, (remaining) => {
            rateLimitRemaining = remaining;
          });
          collected = posts.length;
          allPosts.push(...posts);
          // Reset circuit breaker on success
          this.circuitBreaker.delete(queryKey);
        } catch (err) {
          error = err as Error;
          this.logger.error("Gupy query failed", {
            profile: profile.name,
            term,
            error: error.message,
          });
          errors.push({ profile: profile.name, term, error });
          // Update circuit breaker
          this.updateCircuitBreaker(queryKey);
        }

        const durationMs = Date.now() - startTime;
        queryResults.push({ profile: profile.name, term, collected, durationMs, rateLimitRemaining, error });

        // Log structured query result
        this.logger.info("Gupy query completed", {
          source: "gupy",
          profile: profile.name,
          term,
          collected,
          durationMs,
          rateLimitRemaining,
          error: error?.message ?? null,
        });

        // Warn if rate limit is low
        if (rateLimitRemaining !== null && rateLimitRemaining < 5) {
          this.logger.warn("Gupy rate limit low", {
            profile: profile.name,
            term,
            rateLimitRemaining,
          });
        }
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
        rateLimitRemaining: q.rateLimitRemaining,
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

  private async fetchPostsForProfileAndTerm(
    profile: GupySearchProfile,
    term: string,
    maxPages: number,
    cutoffTime: number,
    seenIds: Set<number>,
    onRateLimitHeader: (remaining: number | null) => void
  ): Promise<Post[]> {
    const posts: Post[] = [];
    let rateLimitRemaining: number | null = null;
    let lastError: Error | null = null;
    let hadSuccess = false;

    for (let page = 0; page < maxPages; page++) {
      const url = this.buildSearchUrl(profile, term, page);
      let response: Response;

      try {
        response = await this.httpClient.get(url);
      } catch (error) {
        lastError = error as Error;
        if (error instanceof HttpError && error.isRetryable) {
          this.logger.warn("Gupy request failed, retrying", {
            profile: profile.name,
            term,
            page,
            error: error.message,
          });
          continue;
        }
        throw error;
      }

      hadSuccess = true;

      // Parse rate limit headers
      const remainingHeader = response.headers.get("ratelimit-remaining");
      if (remainingHeader) {
        const remaining = parseInt(remainingHeader, 10);
        if (!isNaN(remaining)) {
          rateLimitRemaining = remaining;
        }
      }

      const data = (await response.json()) as GupySearchResponse;

      if (!data.data || data.data.length === 0) {
        break;
      }

      for (const job of data.data) {
        if (job.isTalentPool) {
          this.logger.info("Skipping talent pool job", { jobId: job.id });
          continue;
        }

        if (seenIds.has(job.id)) {
          continue;
        }
        seenIds.add(job.id);

        if (Date.parse(job.publishedDate) < cutoffTime) {
          continue;
        }

        let descriptionHtml = job.description;
        if (!descriptionHtml || descriptionHtml.length < MIN_DESCRIPTION_LENGTH) {
          try {
            const detailResponse = await this.httpClient.get(
              `https://portal-api.gupy.io/api/v1/jobs/${job.id}`
            );
            const detailData = (await detailResponse.json()) as GupyJob;
            if (detailData.description && detailData.description.length >= MIN_DESCRIPTION_LENGTH) {
              descriptionHtml = detailData.description;
            }
          } catch {
            // Ignore fallback errors, use original description
          }
        }

        const post = this.mapJobToPost(job, descriptionHtml);
        posts.push(post);
      }

      if (data.data.length < DEFAULT_PAGE_SIZE) {
        break;
      }
    }

    if (!hadSuccess && lastError) {
      throw lastError;
    }

    onRateLimitHeader(rateLimitRemaining);
    return posts;
  }

  private buildSearchUrl(profile: GupySearchProfile, term: string, page: number): string {
    const params = new URLSearchParams();
    params.set("term", term);
    params.set("page", page.toString());
    params.set("pageSize", DEFAULT_PAGE_SIZE.toString());

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

    return `https://portal-api.gupy.io/api/v1/jobs?${params.toString()}`;
  }

  private mapJobToPost(job: GupyJob, descriptionHtml: string): Post {
    const workplaceType = WORKPLACE_TYPE_MAP[job.workplaceType] ?? job.workplaceType;
    const jobType = JOB_TYPE_MAP[job.jobType] ?? job.jobType;

    const texto = [
      `Título: ${job.name}`,
      `Empresa: ${job.companyName}`,
      `Localização: ${job.city}/${job.state}`,
      `Modalidade: ${workplaceType}`,
      `Tipo: ${jobType}`,
      `Publicado: ${job.publishedDate}`,
      `Descrição: ${descriptionHtml.slice(0, 3000)}`,
    ].join("\n");

    return {
      id: `gupy:${job.id}`,
      url: `https://portal.gupy.io/job/${job.id}`,
      texto,
    };
  }

  private extractPublishedDate(texto: string): number {
    const match = texto.match(/Publicado: (.+)/);
    if (match) {
      return Date.parse(match[1]);
    }
    return 0;
  }
}