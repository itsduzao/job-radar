import { chromium } from "playwright";
import type { Page, Response } from "playwright";
import type { Post } from "./domain.js";
import type { LinkedInScraper } from "./linkedin.js";

const COOKIE_DOMAIN = ".linkedin.com";
const POST_SELECTOR = 'div[role="listitem"][componentkey^="update-card-focus"]';
const ACTIVITY_ID_RE = /activityId["\\]*:\s*["\\]*(\d+)/g;
const RESPONSE_URL_RE = /search\/results\/content|rsc-action\/actions\/pagination/;

// Gupy selectors
const GUPY_JOB_CARD_SELECTOR = '[data-testid="job-card"], .job-card, article[class*="job"]';
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
    return "LinkedIn bloqueou o acesso (sessão sinalizada ou rate-limit) — atualize o LI_COOKIE e aguarde antes de tentar de novo";
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
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([
        { name: "li_at", value: cookie, domain: COOKIE_DOMAIN, path: "/" },
      ]);
      const page = await context.newPage();

      const bodies: Promise<string>[] = [];
      page.on("response", (res) => {
        if (!RESPONSE_URL_RE.test(res.url())) return;
        bodies.push(readBodySafely(res));
      });

      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch (err) {
        const motivo = classifyGotoError(err);
        if (motivo) throw new Error(motivo);
        throw err;
      }
      if (isLoginUrl(page.url())) {
        throw new Error("cookie de sessão do LinkedIn expirado ou inválido");
      }

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
      `  url final: ${page.url()}`,
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

export class GupyPlaywrightScraper implements GupyScraper {
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

      const allJobs: GupyJobCard[] = [];
      let currentPage = 0;
      const maxPages = 20;

      while (currentPage < maxPages) {
        // Wait for job cards to load with longer timeout
        try {
          await page.waitForSelector(GUPY_JOB_CARD_SELECTOR, { timeout: 30_000 });
        } catch {
          // Selector might not match, try to continue anyway
          this.logger?.warn?.("Job card selector not found, continuing", { url });
        }

        // Extract jobs from current page
        const jobs = await this.extractJobs(page);
        allJobs.push(...jobs);

        if (jobs.length === 0) {
          break; // No jobs found, stop pagination
        }

        // Try to go to next page
        const hasNextPage = await this.goToNextPage(page);
        if (!hasNextPage) break;

        currentPage++;
        await page.waitForTimeout(2000); // Rate limiting
      }

      return allJobs.map(job => this.mapJobToPost(job));
    } finally {
      await browser.close().catch(() => {});
    }
  }

  private logger = {
    warn: (msg: string, meta: Record<string, unknown>) => {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), level: "warn", source: "gupy-playwright", msg, ...meta }));
    }
  };

  private async extractJobs(page: Page): Promise<GupyJobCard[]> {
    return page.$$eval(GUPY_JOB_CARD_SELECTOR, (cards) => {
      return cards.map(card => {
        const linkEl = card.querySelector(GUPY_JOB_LINK_SELECTOR);
        const url = linkEl?.getAttribute("href") || "";
        const jobIdMatch = url.match(/\/job\/(\d+)/);
        const id = jobIdMatch ? jobIdMatch[1] : url;

        // Try various selectors for job details
        const title = card.querySelector('[data-testid="job-title"], h2, h3, .job-title, [class*="title"]')?.textContent?.trim() || "";
        const company = card.querySelector('[data-testid="company-name"], .company, [class*="company"]')?.textContent?.trim() || "";
        const location = card.querySelector('[data-testid="job-location"], .location, [class*="location"]')?.textContent?.trim() || "";
        const workplaceType = card.querySelector('[data-testid="workplace-type"], .workplace, [class*="workplace"]')?.textContent?.trim() || "";
        const jobType = card.querySelector('[data-testid="job-type"], .job-type, [class*="type"]')?.textContent?.trim() || "";
        const publishedDate = card.querySelector('[data-testid="published-date"], .date, [class*="date"]')?.textContent?.trim() || new Date().toISOString();
        const description = card.querySelector('[data-testid="job-description"], .description, [class*="description"]')?.textContent?.trim() || "";

        return { id, title, company, location, workplaceType, jobType, publishedDate, description, url };
      }).filter(job => job.title && job.url);
    });
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
}
