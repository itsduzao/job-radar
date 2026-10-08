import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlaywrightScraper } from "../src/playwright-scraper.js";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("playwright", () => ({
  chromium: {
    launch: (...args: unknown[]) => launch(...args),
  },
}));

interface PageMock {
  goto: ReturnType<typeof vi.fn>;
  url: () => string;
  title: () => Promise<string>;
  waitForSelector: ReturnType<typeof vi.fn>;
  $$eval: ReturnType<typeof vi.fn>;
  locator: ReturnType<typeof vi.fn>;
}

function makePage(overrides: Partial<PageMock> = {}): PageMock {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    url: () => "https://www.linkedin.com/search/results/content/",
    title: async () => "LinkedIn",
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    $$eval: vi.fn().mockResolvedValue([]),
    locator: vi.fn().mockReturnValue({
      innerText: vi.fn().mockResolvedValue(""),
    }),
    ...overrides,
  };
}

function mountScraper(page: PageMock) {
  const context = {
    addCookies: vi.fn().mockResolvedValue(undefined),
    newPage: vi.fn().mockResolvedValue(page),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  launch.mockResolvedValue(browser);
}

beforeEach(() => {
  launch.mockReset();
});

describe("PlaywrightScraper", () => {
  it("devolve os posts extraídos da busca", async () => {
    const posts = [
      {
        id: "urn:li:activity:1",
        texto: "Estágio backend",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:1",
      },
    ];
    const page = makePage({ $$eval: vi.fn().mockResolvedValue(posts) });
    mountScraper(page);

    const scraper = new PlaywrightScraper();
    const result = await scraper.fetchPosts("https://busca", "cookie");

    expect(result).toEqual(posts);
    expect(launch).toHaveBeenCalledWith({ headless: true });
  });

  it("inclui diagnóstico quando nenhum post carrega", async () => {
    const page = makePage({
      url: () => "https://www.linkedin.com/search/results/content/?keywords=vaga",
      title: async () => "Página de busca",
      waitForSelector: vi.fn().mockRejectedValue(new Error("timeout")),
      locator: vi.fn().mockReturnValue({
        innerText: vi.fn().mockResolvedValue("corpo da página de erro"),
      }),
    });
    mountScraper(page);

    const scraper = new PlaywrightScraper();
    let error: Error | undefined;
    try {
      await scraper.fetchPosts("https://busca", "cookie");
    } catch (e) {
      error = e as Error;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain("nenhum post carregado");
    expect(error!.message).toContain(
      "url final: https://www.linkedin.com/search/results/content/?keywords=vaga",
    );
    expect(error!.message).toContain("título: Página de busca");
    expect(error!.message).toContain("início do corpo: corpo da página de erro");
  });

  it("falha com mensagem clara quando o cookie está expirado", async () => {
    const page = makePage({
      url: () => "https://www.linkedin.com/login?session_expired=true",
    });
    mountScraper(page);

    const scraper = new PlaywrightScraper();
    await expect(scraper.fetchPosts("https://busca", "cookie")).rejects.toThrow(
      "cookie de sessão do LinkedIn expirado ou inválido",
    );
  });
});
