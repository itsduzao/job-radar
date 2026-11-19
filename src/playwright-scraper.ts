import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import type { Page, Response } from "playwright";
import type { Post } from "./domain.js";
import type { ExtractedJob, JobExtractor } from "./gemini-extractor.js";
import type { Logger } from "./logger.js";
import type { LinkedInScraper } from "./linkedin.js";

const COOKIE_DOMAIN = ".linkedin.com";
const POST_SELECTOR = 'div[role="listitem"][componentkey^="update-card-focus"]';
const ACTIVITY_ID_RE = /activityId["\\]*:\s*["\\]*(\d+)/g;
const RESPONSE_URL_RE = /search\/results\/content|rsc-action\/actions\/pagination/;
const DIAGNOSTICS_PATH = ".diagnostics/linkedin.jsonl";

interface NavigationDiagnostic {
  timestamp: string;
  event: "navigation_started" | "navigation_succeeded" | "navigation_failed";
  initialUrl: string;
  finalUrl?: string;
  elapsedMs: number;
  cookie: {
    configured: boolean;
    inserted: boolean;
    foundInContext: boolean;
    expiresAt: string | null;
  };
  destination: "login" | "checkpoint" | "authwall" | "search" | "other";
  title?: string;
  error?: { name: string; message: string };
  redirects: Array<{ status: number; from: string; to: string | null }>;
  responses: Array<{ status: number; url: string }>;
  failedRequests: Array<{ url: string; error: string | null }>;
  runner: {
    githubActions: boolean;
    os: string | null;
    runId: string | null;
    runAttempt: string | null;
  };
}

function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(url indisponível)";
  }
}

function destinationFor(url: string): NavigationDiagnostic["destination"] {
  if (/\/(checkpoint|challenge)(\/|$)/i.test(url)) return "checkpoint";
  if (url.includes("/authwall")) return "authwall";
  if (url.includes("/login") || url.includes("session_expired")) return "login";
  if (url.includes("/search/results/content")) return "search";
  return "other";
}

async function persistDiagnostic(record: NavigationDiagnostic): Promise<void> {
  const line = JSON.stringify(record);
  console.info("[linkedin-diagnostic] " + line);
  try {
    await mkdir(dirname(DIAGNOSTICS_PATH), { recursive: true });
    await appendFile(DIAGNOSTICS_PATH, line + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    // Diagnostics must never change the scraper's functional result.
    console.warn("[linkedin-diagnostic] could not persist diagnostic file:", err);
  }
}

// Gupy selectors. The card is the list item/article that wraps a job link: the
// portal uses a class-less <li> with the link (and all card text) inside.
const GUPY_JOB_CARD_SELECTOR =
  'li:has(a[href*="/job/"]), article:has(a[href*="/job/"])';
const GUPY_JOB_LINK_SELECTOR = 'a[href*="/job/"]';
const GUPY_NEXT_PAGE_SELECTOR = 'button[aria-label="Próxima página"], a[rel="next"], button:has-text("Próxima")';
const GUPY_LOAD_MORE_SELECTOR = 'button:has-text("Carregar mais"), button:has-text("Ver mais")';

export function isLoginUrl(url: string): boolean {
  return (
    url.includes("/login") ||
    url.includes("/authwall") ||
    url.includes("session_expired")
  );
}

export function classifyGotoError(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  if (/ERR_TOO_MANY_REDIRECTS/i.test(err.message)) {
    return "Falha de navegação no LinkedIn: ERR_TOO_MANY_REDIRECTS (causa ainda não determinada; consulte os eventos linkedin-diagnostic)";
  }
  return null;
}

export function extractActivityIds(body: string): string[] {
  const ids: string[] = [];
  ACTIVITY_ID_RE.lastIndex = 0;
  for (const match of body.matchAll(ACTIVITY_ID_RE)) {
    const id = match[1];
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function cleanCardText(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^Publicação no feed\s*/, "").trim();
}

export function postFromCard(
  card: { componentkey: string; text: string },
  activityId: string | undefined,
  fallbackUrl: string,
): Post {
  const id = activityId ? `urn:li:activity:${activityId}` : card.componentkey;
  const url = activityId
    ? `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}`
    : fallbackUrl;
  return { id, texto: cleanCardText(card.text), url };
}

async function readBodySafely(res: Response): Promise<string> {
  return Promise.race([
    res.text(),
    new Promise<string>((resolve) => setTimeout(() => resolve(""), 8_000)),
  ]).catch(() => "");
}

export class PlaywrightScraper implements LinkedInScraper {
  async fetchPosts(url: string, cookie: string): Promise<Post[]> {
    const startedAt = Date.now();
    const redirects: NavigationDiagnostic["redirects"] = [];
    const responses: NavigationDiagnostic["responses"] = [];
    const failedRequests: NavigationDiagnostic["failedRequests"] = [];
    const browser = await chromium.launch({ headless: true });
    let cookieInserted = false;
    let cookieFound = false;
    let cookieExpiresAt: string | null = null;
    let page: Page | undefined;

    const buildDiagnostic = async (
      event: NavigationDiagnostic["event"],
      error?: unknown,
    ): Promise<NavigationDiagnostic> => {
      const finalUrl = page?.url() ?? url;
      const record: NavigationDiagnostic = {
        timestamp: new Date().toISOString(),
        event,
        initialUrl: safeUrl(url),
        finalUrl: safeUrl(finalUrl),
        elapsedMs: Date.now() - startedAt,
        cookie: {
          configured: cookie.length > 0,
          inserted: cookieInserted,
          foundInContext: cookieFound,
          expiresAt: cookieExpiresAt,
        },
        destination: destinationFor(finalUrl),
        redirects,
        responses,
        failedRequests,
        runner: {
          githubActions: process.env.GITHUB_ACTIONS === "true",
          os: process.env.RUNNER_OS ?? null,
          runId: process.env.GITHUB_RUN_ID ?? null,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
        },
      };
      if (page) record.title = await page.title().catch(() => "(indisponível)");
      if (error instanceof Error) {
        record.error = {
          name: error.name,
          message: error.message.replace(/https?:\/\/[^\s)]+/g, (match) => safeUrl(match)),
        };
      } else if (error !== undefined) {
        record.error = { name: "UnknownError", message: String(error) };
      }
      return record;
    };

    try {
      const context = await browser.newContext();
      await context.addCookies([
        { name: "li_at", value: cookie, domain: COOKIE_DOMAIN, path: "/" },
      ]);
      cookieInserted = true;
      const storedCookies = await context.cookies("https://www.linkedin.com");
      const storedCookie = storedCookies.find((item) => item.name === "li_at");
      cookieFound = Boolean(storedCookie);
      if (storedCookie && storedCookie.expires > 0) {
        cookieExpiresAt = new Date(storedCookie.expires * 1000).toISOString();
      }
      page = await context.newPage();

      const bodies: Promise<string>[] = [];
      page.on("response", (res) => {
        const responseUrl = res.url();
        if (responses.length < 100) responses.push({ status: res.status(), url: safeUrl(responseUrl) });
        if (res.status() >= 300 && res.status() < 400) {
          const location = res.headers().location;
          if (redirects.length < 50) {
            let target: string | null = null;
            try {
              target = location ? safeUrl(new URL(location, responseUrl).toString()) : null;
            } catch {
              target = "(location inválido)";
            }
            redirects.push({ status: res.status(), from: safeUrl(responseUrl), to: target });
          }
        }
        if (RESPONSE_URL_RE.test(responseUrl)) bodies.push(readBodySafely(res));
      });
      page.on("requestfailed", (request) => {
        if (failedRequests.length < 50) {
          failedRequests.push({
            url: safeUrl(request.url()),
            error: request.failure()?.errorText ?? null,
          });
        }
      });

      console.info("[linkedin-diagnostic] " + JSON.stringify({
        event: "navigation_started",
        timestamp: new Date(startedAt).toISOString(),
        initialUrl: safeUrl(url),
        cookieConfigured: cookie.length > 0,
        cookieInserted,
        cookieFoundInContext: cookieFound,
      }));

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (err) {
        const diagnostic = await buildDiagnostic("navigation_failed", err);
        await persistDiagnostic(diagnostic);
        const motivo = classifyGotoError(err);
        if (motivo) throw new Error(motivo, { cause: err });
        throw err;
      }

      if (isLoginUrl(page.url())) {
        const err = new Error("cookie de sessão do LinkedIn expirado ou inválido");
        await persistDiagnostic(await buildDiagnostic("navigation_failed", err));
        throw err;
      }

      await persistDiagnostic(await buildDiagnostic("navigation_succeeded"));
      const cards = await this.extractPosts(page);

      const activityIds: string[] = [];
      for (const body of await Promise.all(bodies)) {
        for (const id of extractActivityIds(body)) {
          if (!activityIds.includes(id)) activityIds.push(id);
        }
      }

      return cards.map((card, i) => postFromCard(card, activityIds[i], url));
    } finally {
      await browser.close();
    }
  }

  private async extractPosts(
    page: Page,
  ): Promise<{ componentkey: string; text: string }[]> {
    try {
      await page.waitForSelector(POST_SELECTOR, { timeout: 15_000 });
    } catch {
      const diagnostico = await this.coletarDiagnostico(page);
      throw new Error(
        `nenhum post carregado na busca do LinkedIn (seletores podem ter mudado)\n${diagnostico}`,
      );
    }
    // Best-effort: rola para disparar a paginação e carregar mais posts.
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 2000).catch(() => {});
      await page.waitForTimeout(1500);
    }
    return page.$$eval(POST_SELECTOR, (els) =>
      els.map((el) => ({
        componentkey: el.getAttribute("componentkey") ?? "",
        text: el.innerText ?? "",
      })),
    );
  }

  private async coletarDiagnostico(page: Page): Promise<string> {
    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    return [
      `  url final: ${safeUrl(page.url())}`,
      `  título: ${(await page.title()) || "(vazio)"}`,
      `  início do corpo: ${bodyText.slice(0, 500) || "(vazio)"}`,
    ].join("\n");
  }
}

export interface GupyScraper {
  fetchPosts(url: string): Promise<Post[]>;
}

interface GupyJobCard {
  id: string;
  title: string;
  company: string;
  location: string;
  workplaceType: string;
  jobType: string;
  publishedDate: string;
  description: string;
  url: string;
}

const DEFAULT_GUPY_MAX_PAGES = 20;

const defaultGupyLogger: Logger = {
  info: () => {},
  warn: (msg, fields) => {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        source: "gupy-playwright",
        msg,
        ...fields,
      }),
    );
  },
  error: () => {},
  child: () => defaultGupyLogger,
};

export class GupyPlaywrightScraper implements GupyScraper {
  private readonly logger: Logger;

  constructor(
    private readonly extractor?: JobExtractor,
    private readonly useLLM = false,
    logger?: Logger,
    private readonly shadow = false,
  ) {
    this.logger = logger ?? defaultGupyLogger;
  }

  async fetchPosts(url: string): Promise<Post[]> {
    const browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    try {
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
      });
      const page = await context.newPage();

      // Block unnecessary resources to speed up
      await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2}', route => route.abort());
      
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch (err) {
        throw new Error(`Falha ao acessar Gupy: ${err instanceof Error ? err.message : String(err)}`);
      }

      const maxPages = parseInt(process.env.GUPY_MAX_PAGES ?? "", 10) || DEFAULT_GUPY_MAX_PAGES;
      const extractor = this.extractor;
      const posts: Post[] = [];
      const seenIds = new Set<string>();
      let currentPage = 0;

      while (currentPage < maxPages) {
        if (this.useLLM && extractor) {
          const pageResult = await this.extractPageWithLLM(
            page,
            url,
            currentPage,
            extractor,
          );

          for (const post of pageResult.posts) {
            if (seenIds.has(post.id)) continue;
            seenIds.add(post.id);
            posts.push(post);
          }

          if (pageResult.jobsOut === 0) {
            break; // No jobs found, stop pagination
          }
        } else if (this.shadow && extractor) {
          const pageResult = await this.extractPageInShadow(
            page,
            url,
            currentPage,
            extractor,
          );

          posts.push(...pageResult.posts);

          if (pageResult.jobsOut === 0) {
            break; // Legacy output is the source of truth; stop when it is empty
          }
        } else {
          await this.waitForLegacyCards(page, url);

          // Extract jobs from current page using the legacy selectors
          const jobs = await this.extractJobs(page);
          if (jobs.length === 0) {
            break; // No jobs found, stop pagination
          }
          posts.push(...jobs.map((job) => this.mapJobToPost(job)));
        }

        // Try to go to next page
        const hasNextPage = await this.goToNextPage(page);
        if (!hasNextPage) break;

        currentPage++;
        await page.waitForTimeout(2000); // Rate limiting
      }

      return posts;
    } finally {
      await browser.close().catch(() => {});
    }
  }

  private async waitForLegacyCards(page: Page, url: string): Promise<void> {
    try {
      await page.waitForSelector(GUPY_JOB_CARD_SELECTOR, { timeout: 30_000 });
    } catch {
      // Selector might not match, try to continue anyway
      this.logger.warn("Job card selector not found, continuing", { url });
    }
  }

  private async extractPageWithLLM(
    page: Page,
    url: string,
    pageIndex: number,
    extractor: JobExtractor,
  ): Promise<{ posts: Post[]; jobsOut: number }> {
    const cardHtmls = await this.prepareLLMCards(page, url, pageIndex);

    if (cardHtmls.length === 0) {
      return { posts: [], jobsOut: 0 };
    }

    try {
      const jobs = await this.runLLMExtraction(cardHtmls, url, pageIndex, extractor);
      return {
        posts: jobs.map((job) => this.mapExtractedJobToPost(job)),
        jobsOut: jobs.length,
      };
    } catch (err) {
      this.logger.warn("llm_extraction failed; falling back to legacy selectors", {
        page: pageIndex,
        cardsIn: cardHtmls.length,
        error: err instanceof Error ? err.message : String(err),
      });

      const legacyJobs = await this.extractJobs(page);
      this.logger.info("llm_extraction", {
        page: pageIndex,
        cardsIn: cardHtmls.length,
        jobsOut: legacyJobs.length,
        fallbackUsed: true,
      });
      return {
        posts: legacyJobs.map((job) => this.mapJobToPost(job)),
        jobsOut: legacyJobs.length,
      };
    }
  }

  /**
   * Shadow mode: returns the legacy mapping (production source of truth) while
   * also running the LLM path so divergence can be measured. LLM failures are
   * logged and never affect the returned posts.
   */
  private async extractPageInShadow(
    page: Page,
    url: string,
    pageIndex: number,
    extractor: JobExtractor,
  ): Promise<{ posts: Post[]; jobsOut: number }> {
    await this.waitForLegacyCards(page, url);
    const legacyJobs = await this.extractJobs(page);

    let llmJobs: ExtractedJob[] = [];
    try {
      const cardHtmls = await this.prepareLLMCards(page, url, pageIndex);
      if (cardHtmls.length > 0) {
        llmJobs = await this.runLLMExtraction(cardHtmls, url, pageIndex, extractor);
      }
    } catch (err) {
      this.logger.warn("shadow llm_extraction failed; keeping legacy output", {
        page: pageIndex,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const legacyIds = [...new Set(legacyJobs.map((job) => job.id))];
    const llmIds = [...new Set(llmJobs.map((job) => job.id))];
    const legacyIdSet = new Set(legacyIds);
    const llmIdSet = new Set(llmIds);
    const idsOnlyLegacy = legacyIds.filter((id) => !llmIdSet.has(id));
    const idsOnlyLlm = llmIds.filter((id) => !legacyIdSet.has(id));
    const matched = legacyIds.filter((id) => llmIdSet.has(id)).length;

    this.logger.info("shadow", {
      shadow: true,
      page: pageIndex,
      cardsLegacy: legacyJobs.length,
      cardsLlm: llmJobs.length,
      idsOnlyLegacy,
      idsOnlyLlm,
      matched,
      missed: idsOnlyLegacy.length,
    });

    return {
      posts: legacyJobs.map((job) => this.mapJobToPost(job)),
      jobsOut: legacyJobs.length,
    };
  }

  private async prepareLLMCards(
    page: Page,
    url: string,
    pageIndex: number,
  ): Promise<string[]> {
    try {
      await page.waitForSelector(GUPY_JOB_LINK_SELECTOR, { timeout: 30_000 });
    } catch {
      this.logger.warn("Job link selector not found, continuing", { url, page: pageIndex });
    }

    const cardHtmls = await this.discoverCardHtmls(page);

    if (cardHtmls.length === 0) {
      this.logger.info("llm_extraction", {
        page: pageIndex,
        cardsIn: 0,
        jobsOut: 0,
        fallbackUsed: false,
      });
    }

    return cardHtmls;
  }

  private async runLLMExtraction(
    cardHtmls: string[],
    url: string,
    pageIndex: number,
    extractor: JobExtractor,
  ): Promise<ExtractedJob[]> {
    const jobs = await extractor.extractJobs(cardHtmls, url);
    this.logger.info("llm_extraction", {
      page: pageIndex,
      cardsIn: cardHtmls.length,
      jobsOut: jobs.length,
      fallbackUsed: false,
    });
    return jobs;
  }

  private async discoverCardHtmls(page: Page): Promise<string[]> {
    return page.$$eval(GUPY_JOB_LINK_SELECTOR, (links) => {
      const seenHrefs = new Set<string>();
      const cardHtmls: string[] = [];

      for (const link of links) {
        const href = link.getAttribute("href") ?? "";
        if (!href || seenHrefs.has(href)) continue;

        const card = link.closest("li, article");
        if (!card) continue;

        seenHrefs.add(href);
        cardHtmls.push(card.outerHTML);
      }

      return cardHtmls;
    });
  }

  private async extractJobs(page: Page): Promise<GupyJobCard[]> {
    // Playwright serializes this callback and runs it inside the page, where
    // module-scope bindings and bundler helpers (e.g. tsx/esbuild's __name) do
    // not exist. Keep the callback self-contained: literal selectors only, no
    // named inner functions. Id decoding happens back here in Node.
    const cards = await page.$$eval(GUPY_JOB_CARD_SELECTOR, (elements) =>
      elements
        .map((card) => {
          const linkEl = card.querySelector('a[href*="/job/"]');
          const url = linkEl?.getAttribute("href") || "";

          // Try various selectors for job details
          const title =
            card
              .querySelector('[data-testid="job-title"], h2, h3, .job-title, [class*="title"]')
              ?.textContent?.trim() || "";
          const company =
            card
              .querySelector('[data-testid="company-name"], .company, [class*="company"], p')
              ?.textContent?.trim() || "";
          const location =
            card
              .querySelector('[data-testid="job-location"], .location, [class*="location"]')
              ?.textContent?.trim() || "";
          const workplaceType =
            card
              .querySelector('[data-testid="workplace-type"], .workplace, [class*="workplace"]')
              ?.textContent?.trim() || "";
          const jobType =
            card
              .querySelector('[data-testid="job-type"], .job-type, [class*="type"]')
              ?.textContent?.trim() || "";
          const publishedDate =
            card
              .querySelector('[data-testid="published-date"], .date, [class*="date"]')
              ?.textContent?.trim() || new Date().toISOString();
          const description =
            card
              .querySelector('[data-testid="job-description"], .description, [class*="description"]')
              ?.textContent?.trim() || "";

          return {
            title,
            company,
            location,
            workplaceType,
            jobType,
            publishedDate,
            description,
            url,
          };
        })
        .filter((job) => job.title && job.url),
    );

    return cards.map((card) => ({
      ...card,
      id: this.legacyJobIdFromHref(card.url),
    }));
  }

  /**
   * Real card hrefs are https://{company}.gupy.io/job/{base64url}, where the
   * token decodes to {"jobId":<number>,"source":"gupy_portal"} (ADR-0004).
   * Decode it so legacy ids match the numeric ids produced by the LLM path;
   * otherwise keep the plain numeric match, else fall back to the raw href.
   * Runs in Node (not in the page) on purpose — see extractJobs.
   */
  private legacyJobIdFromHref(url: string): string {
    const token = /\/job\/([^/?#]+)/.exec(url)?.[1];
    if (token && !/^\d+$/.test(token)) {
      try {
        const decoded: unknown = JSON.parse(
          Buffer.from(token, "base64url").toString("utf8"),
        );
        if (typeof decoded === "object" && decoded !== null && "jobId" in decoded) {
          const jobId = (decoded as { jobId: unknown }).jobId;
          if (typeof jobId === "number" && Number.isInteger(jobId) && jobId > 0) {
            return String(jobId);
          }
        }
      } catch {
        // Not a base64 JSON token; fall through to the numeric/url fallbacks.
      }
    }

    const numeric = /\/job\/(\d+)/.exec(url);
    return numeric ? numeric[1] : url;
  }

  private async goToNextPage(page: Page): Promise<boolean> {
    // Try multiple selectors for pagination
    const nextSelectors = [
      GUPY_NEXT_PAGE_SELECTOR,
      GUPY_LOAD_MORE_SELECTOR,
      'button:has-text("Próxima")',
      'button:has-text("Mais")',
      'a[rel="next"]',
      'button[aria-label="Next page"]',
    ];

    for (const selector of nextSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click({ timeout: 5000 });
          await page.waitForLoadState("domcontentloaded", { timeout: 10_000 });
          return true;
        }
      } catch {
        // Try next selector
      }
    }
    return false;
  }

  private mapJobToPost(job: GupyJobCard): Post {
    const workplaceTypeMap: Record<string, string> = {
      remote: "remoto",
      "remoto": "remoto",
      onsite: "presencial",
      "presencial": "presencial",
      hybrid: "hibrido",
      "hibrido": "hibrido",
      "híbrido": "hibrido",
    };
    const jobTypeMap: Record<string, string> = {
      internship: "estagio",
      "estagio": "estagio",
      "estágio": "estagio",
      trainee: "junior",
      effective: "junior",
      "efetivo": "junior",
      junior: "junior",
      "júnior": "junior",
    };

    const modalidade = workplaceTypeMap[job.workplaceType.toLowerCase()] || job.workplaceType;
    const tipo = jobTypeMap[job.jobType.toLowerCase()] || job.jobType;

    const texto = [
      `Título: ${job.title}`,
      `Empresa: ${job.company}`,
      `Localização: ${job.location}`,
      `Modalidade: ${modalidade}`,
      `Tipo: ${tipo}`,
      `Publicado: ${job.publishedDate}`,
      `Descrição: ${job.description.slice(0, 3000)}`,
    ].join("\n");

    return {
      id: `gupy:${job.id}`,
      url: job.url.startsWith("http") ? job.url : `https://portal.gupy.io${job.url}`,
      texto,
    };
  }

  private mapExtractedJobToPost(job: ExtractedJob): Post {
    const workplaceTypeMap: Record<ExtractedJob["workplaceType"], string> = {
      remote: "remoto",
      onSite: "presencial",
      hybrid: "hibrido",
      unknown: "desconhecido",
    };
    const jobTypeMap: Record<ExtractedJob["jobType"], string> = {
      internship: "estagio",
      trainee: "junior",
      effective: "junior",
      talent_pool: "banco de talentos",
      unknown: "desconhecido",
    };

    const texto = [
      `Título: ${job.title}`,
      `Empresa: ${job.company}`,
      `Localização: ${job.location}`,
      `Modalidade: ${workplaceTypeMap[job.workplaceType]}`,
      `Tipo: ${jobTypeMap[job.jobType]}`,
      `Publicado: ${job.publishedDate}`,
      `Descrição: ${job.description.slice(0, 3000)}`,
    ].join("\n");

    return {
      id: `gupy:${job.id}`,
      url: `https://portal.gupy.io/job/${job.id}`,
      texto,
    };
  }
}
