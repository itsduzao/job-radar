import { chromium } from "playwright";
import type { Page } from "playwright";
import type { Post } from "./domain.js";
import type { LinkedInScraper } from "./linkedin.js";

const COOKIE_DOMAIN = ".linkedin.com";

export function isLoginUrl(url: string): boolean {
  return (
    url.includes("/login") ||
    url.includes("/authwall") ||
    url.includes("session_expired")
  );
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
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

      if (isLoginUrl(page.url())) {
        throw new Error("cookie de sessão do LinkedIn expirado ou inválido");
      }

      return await this.extractPosts(page);
    } finally {
      await browser.close();
    }
  }

  private async extractPosts(page: Page): Promise<Post[]> {
    try {
      await page.waitForSelector("[data-urn]", { timeout: 15_000 });
    } catch {
      throw new Error(
        "nenhum post carregado na busca do LinkedIn (seletores podem ter mudado)",
      );
    }
    // Best-effort: o DOM do LinkedIn muda sem aviso; estes seletores podem exigir ajuste.
    return page.$$eval("[data-urn]", (els) =>
      els
        .map((el) => {
          const urn = el.getAttribute("data-urn") ?? "";
          const container = el.closest("div.feed-shared-update-v2") ?? el;
          return {
            id: urn,
            texto: container.textContent ?? "",
            url: `https://www.linkedin.com/feed/update/${urn}`,
          };
        })
        .filter((p) => p.id.startsWith("urn:li:activity:")),
    );
  }
}
