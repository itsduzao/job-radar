import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyGotoError,
  cleanCardText,
  extractActivityIds,
  isLoginUrl,
  PlaywrightScraper,
  postFromCard,
} from "../src/playwright-scraper.js";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("playwright", () => ({
  chromium: { launch: (...args: unknown[]) => launch(...args) },
}));

interface ResponseLike {
  url(): string;
  text(): Promise<string>;
}

function makePage() {
  const pendingResponses: ResponseLike[] = [];
  let responseHandler: ((res: ResponseLike) => void) | undefined;

  const page = {
    on: vi.fn((event: string, handler: (res: ResponseLike) => void) => {
      if (event === "response") responseHandler = handler;
    }),
    goto: vi.fn(async () => {
      for (const res of pendingResponses) responseHandler?.(res);
    }),
    url: () => "https://www.linkedin.com/search/results/content/",
    title: async () => "LinkedIn",
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    mouse: { wheel: vi.fn().mockResolvedValue(undefined) },
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    $$eval: vi.fn().mockResolvedValue([]),
    locator: vi.fn().mockReturnValue({
      innerText: vi.fn().mockResolvedValue(""),
    }),
  };

  return {
    page,
    addResponse(res: ResponseLike) {
      pendingResponses.push(res);
    },
  };
}

function mountScraper(page: ReturnType<typeof makePage>["page"]) {
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

describe("extractActivityIds", () => {
  it("extrai ids de activityId com aspas escapadas, em ordem e sem duplicar", () => {
    const body = '\\"activityId\\":\\"7513760849698729984\\" x \\"activityId\\":\\"7513753532878061568\\" y \\"activityId\\":\\"7513760849698729984\\"';
    expect(extractActivityIds(body)).toEqual([
      "7513760849698729984",
      "7513753532878061568",
    ]);
  });

  it("extrai ids de activityId com aspas não escapadas", () => {
    expect(extractActivityIds('"activityId":"123456789"')).toEqual(["123456789"]);
  });

  it("devolve lista vazia quando não há activityId", () => {
    expect(extractActivityIds("sem atividade")).toEqual([]);
  });
});

describe("cleanCardText", () => {
  it("remove o cabeçalho e colapsa espaços", () => {
    expect(
      cleanCardText("Publicação no feed  Acme   há 1 h   Vaga backend remoto"),
    ).toBe("Acme há 1 h Vaga backend remoto");
  });
});

describe("classifyGotoError", () => {
  it("identifica o loop de redirecionamento do LinkedIn", () => {
    expect(classifyGotoError(new Error("page.goto: net::ERR_TOO_MANY_REDIRECTS at https://..."))).toContain(
      "bloqueou o acesso",
    );
  });

  it("devolve null para outros erros", () => {
    expect(classifyGotoError(new Error("timeout"))).toBeNull();
    expect(classifyGotoError("string")).toBeNull();
  });
});

describe("postFromCard", () => {
  it("usa o activityId como id e url quando presente", () => {
    expect(
      postFromCard(
        { componentkey: "update-card-focusABC", text: "Publicação no feed Vaga backend" },
        "123",
        "https://busca",
      ),
    ).toEqual({
      id: "urn:li:activity:123",
      texto: "Vaga backend",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:123",
    });
  });

  it("usa o componentkey como id e a url de busca quando não há activityId", () => {
    expect(
      postFromCard({ componentkey: "update-card-focusABC", text: "Vaga" }, undefined, "https://busca"),
    ).toEqual({
      id: "update-card-focusABC",
      texto: "Vaga",
      url: "https://busca",
    });
  });
});

describe("PlaywrightScraper", () => {
  it("extrai posts com URN a partir dos cards e das respostas", async () => {
    const { page, addResponse } = makePage();
    page.$$eval.mockResolvedValue([
      {
        componentkey: "update-card-focusABCFeedType_FLAGSHIP_SEARCH",
        text: "Publicação no feed Acme há 1 h Vaga backend remoto",
      },
    ]);
    addResponse({
      url: () => "https://www.linkedin.com/search/results/content/",
      text: async () => '\\"activityId\\":\\"7513760849698729984\\"',
    });
    mountScraper(page);

    const posts = await new PlaywrightScraper().fetchPosts("https://busca", "cookie");

    expect(posts).toEqual([
      {
        id: "urn:li:activity:7513760849698729984",
        texto: "Acme há 1 h Vaga backend remoto",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:7513760849698729984",
      },
    ]);
  });

  it("cai para o componentkey quando não há activityId na resposta", async () => {
    const { page } = makePage();
    page.$$eval.mockResolvedValue([
      { componentkey: "update-card-focusABC", text: "Publicação no feed Vaga" },
    ]);
    mountScraper(page);

    const posts = await new PlaywrightScraper().fetchPosts("https://busca", "cookie");

    expect(posts[0].id).toBe("update-card-focusABC");
    expect(posts[0].url).toBe("https://busca");
  });

  it("falha com mensagem clara quando o cookie está expirado", async () => {
    const { page } = makePage();
    page.url = () => "https://www.linkedin.com/login?session_expired=true";
    mountScraper(page);

    await expect(
      new PlaywrightScraper().fetchPosts("https://busca", "cookie"),
    ).rejects.toThrow("cookie de sessão do LinkedIn expirado ou inválido");
  });

  it("falha com mensagem clara quando o LinkedIn bloqueia por redirect loop", async () => {
    const { page } = makePage();
    page.goto = vi.fn().mockRejectedValue(
      new Error("page.goto: net::ERR_TOO_MANY_REDIRECTS at https://www.linkedin.com/"),
    );
    mountScraper(page);

    await expect(
      new PlaywrightScraper().fetchPosts("https://busca", "cookie"),
    ).rejects.toThrow("bloqueou o acesso");
  });

  it("inclui diagnóstico quando nenhum post carrega", async () => {
    const { page } = makePage();
    page.waitForSelector = vi.fn().mockRejectedValue(new Error("timeout"));
    page.url = () => "https://www.linkedin.com/search/results/content/?keywords=vaga";
    page.title = async () => "Página de busca";
    page.locator = vi.fn().mockReturnValue({
      innerText: vi.fn().mockResolvedValue("corpo da página de erro"),
    });
    mountScraper(page);

    let error: Error | undefined;
    try {
      await new PlaywrightScraper().fetchPosts("https://busca", "cookie");
    } catch (e) {
      error = e as Error;
    }

    expect(error!.message).toContain("nenhum post carregado");
    expect(error!.message).toContain("url final: https://www.linkedin.com/search/results/content/?keywords=vaga");
    expect(error!.message).toContain("título: Página de busca");
    expect(error!.message).toContain("início do corpo: corpo da página de erro");
  });
});

describe("isLoginUrl", () => {
  it("detecta páginas de login", () => {
    expect(isLoginUrl("https://www.linkedin.com/login?session_expired")).toBe(true);
    expect(isLoginUrl("https://www.linkedin.com/authwall")).toBe(true);
  });

  it("não marca a busca de conteúdo como login", () => {
    expect(isLoginUrl("https://www.linkedin.com/search/results/content/")).toBe(false);
  });
});
