import { chromium } from "playwright";
import type { Page, Response } from "playwright";
import type { Post } from "./domain.js";
import type { LinkedInScraper } from "./linkedin.js";

const COOKIE_DOMAIN = ".linkedin.com";
const POST_SELECTOR = 'div[role="listitem"][componentkey^="update-card-focus"]';
const ACTIVITY_ID_RE = /activityId["\\]*:\s*["\\]*(\d+)/g;
const RESPONSE_URL_RE = /search\/results\/content|rsc-action\/actions\/pagination/;

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
