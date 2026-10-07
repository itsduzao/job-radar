import { chromium } from "playwright";
import type { Page } from "playwright";
import type { LinkedInScraper, RawPost } from "./linkedin.js";

const COOKIE_DOMAIN = ".linkedin.com";

export class PlaywrightScraper implements LinkedInScraper {
  async fetchRawPosts(url: string, cookie: string): Promise<RawPost[]> {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.addCookies([
        { name: "li_at", value: cookie, domain: COOKIE_DOMAIN, path: "/" },
      ]);
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });

      if (await this.isLoginPage(page)) {
        throw new Error("cookie de sessão do LinkedIn expirado ou inválido");
      }

      return await this.extractPosts(page);
    } finally {
      await browser.close();
    }
  }

  private async isLoginPage(page: Page): Promise<boolean> {
    const url = page.url();
    return (
      url.includes("/login") ||
      url.includes("/authwall") ||
      url.includes("session_expired")
    );
  }

  private async extractPosts(page: Page): Promise<RawPost[]> {
    // Best-effort: o DOM do LinkedIn muda sem aviso; estes seletores podem exigir ajuste.
    return page.$$eval("[data-urn]", (els) =>
      els
        .map((el) => {
          const urn = el.getAttribute("data-urn") ?? "";
          const container = el.closest("div.feed-shared-update-v2") ?? el;
          return {
            urn,
            texto: container.textContent ?? "",
            url: `https://www.linkedin.com/feed/update/${urn}`,
          };
        })
        .filter((p) => p.urn.startsWith("urn:li:activity:")),
    );
  }
}
