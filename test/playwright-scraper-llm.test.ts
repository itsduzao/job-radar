import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GupyPlaywrightScraper } from "../src/playwright-scraper.js";
import { GupySource } from "../src/gupy.js";
import type { ExtractedJob, JobExtractor } from "../src/gemini-extractor.js";
import type { GupySearchConfig } from "../src/config.js";
import type { LogFields, Logger } from "../src/logger.js";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("playwright", () => ({
  chromium: { launch: (...args: unknown[]) => launch(...args) },
}));

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/gupy/${name}`, import.meta.url), "utf8");
}

const extractedJobs = JSON.parse(readFixture("extracted-jobs-real.json")) as ExtractedJob[];
const jobCards = JSON.parse(readFixture("job-cards-real.json")) as string[];

const SOURCE_URL = "https://portal.gupy.io/job-search/term=estagio";
const JOB_LINK_SELECTOR = 'a[href*="/job/"]';
const LEGACY_CARD_SELECTOR = '[data-testid="job-card"], .job-card, article[class*="job"]';

interface LegacyJob {
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

/**
 * Minimal DOM shim for the legacy extractJobs $$eval callback: a card answers
 * `querySelector` for the job link (with its href) and for the title selector;
 * everything else resolves to null so the callback's fallbacks apply.
 */
interface FakeLegacyCard {
  querySelector: (
    selector: string,
  ) => { getAttribute?: (name: string) => string | null; textContent?: string | null } | null;
}

function fakeLegacyCard(options: { href?: string; title?: string }): FakeLegacyCard {
  const { href, title } = options;
  return {
    querySelector: (selector: string) => {
      if (selector === JOB_LINK_SELECTOR) {
        return href === undefined
          ? null
          : { getAttribute: (name: string) => (name === "href" ? href : null) };
      }
      if (selector.includes("title")) {
        return { textContent: title ?? null };
      }
      return null;
    },
  };
}

/** Real card hrefs from the captured page, e.g. https://{company}.gupy.io/job/{base64url}. */
const realCardHrefs = jobCards
  .map((html) => /href="(https:\/\/[^"]+\/job\/[^"]+)"/.exec(html)?.[1] ?? null)
  .filter((href): href is string => href !== null);

const legacyJob: LegacyJob = {
  id: "999",
  title: "Estágio Legado",
  company: "Acme",
  location: "Florianópolis/SC",
  workplaceType: "remote",
  jobType: "internship",
  publishedDate: "2026-11-18T00:00:00-03:00",
  description: "Vaga extraída pelos seletores antigos",
  url: "https://acme.gupy.io/job/999",
};

interface GupyPageState {
  cardHtmlPages: string[][];
  legacyJobs: LegacyJob[];
  legacyCards: FakeLegacyCard[];
  maxNextClicks: number;
  nextClicks: number;
  discoveryCalls: number;
}

function makeGupyPage(overrides: Partial<GupyPageState> = {}) {
  const state: GupyPageState = {
    cardHtmlPages: [],
    legacyJobs: [],
    legacyCards: [],
    maxNextClicks: 0,
    nextClicks: 0,
    discoveryCalls: 0,
    ...overrides,
  };

  const page = {
    route: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockResolvedValue(undefined),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    $$eval: vi.fn(
      async (selector: string, callback?: (elements: unknown[]) => unknown) => {
        if (selector === JOB_LINK_SELECTOR) {
          const index = state.discoveryCalls;
          state.discoveryCalls += 1;
          return state.cardHtmlPages[index] ?? [];
        }
        if (state.legacyCards.length > 0) {
          // Run the real production callback against the fake cards so the
          // legacy id derivation is exercised end to end.
          return callback?.(state.legacyCards);
        }
        return state.legacyJobs;
      },
    ),
    locator: vi.fn(() => ({
      first: () => ({
        isVisible: async () => state.nextClicks < state.maxNextClicks,
        click: async () => {
          state.nextClicks += 1;
        },
      }),
    })),
  };

  const context = { newPage: vi.fn().mockResolvedValue(page) };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  launch.mockResolvedValue(browser);

  return { page, state };
}

function createExtractor(responses: ExtractedJob[][]): {
  extractor: JobExtractor;
  extractJobs: ReturnType<typeof vi.fn>;
} {
  const extractJobs = vi.fn(
    async (_chunks: string[], _url: string): Promise<ExtractedJob[]> =>
      responses.shift() ?? [],
  );
  return { extractor: { extractJobs }, extractJobs };
}

function createCapturingLogger(): {
  logger: Logger;
  calls: { level: string; msg: string; fields?: LogFields }[];
} {
  const calls: { level: string; msg: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    info: (msg, fields) => calls.push({ level: "info", msg, fields }),
    warn: (msg, fields) => calls.push({ level: "warn", msg, fields }),
    error: (msg, fields) => calls.push({ level: "error", msg, fields }),
    child: () => logger,
  };
  return { logger, calls };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  launch.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.GUPY_MAX_PAGES;
  delete process.env.GUPY_DRY_RUN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GUPY_MAX_PAGES;
  delete process.env.GUPY_DRY_RUN;
});

describe("GupyPlaywrightScraper em modo LLM", () => {
  it("mapeia ExtractedJob para Post com id, url canônica e texto enriquecido", async () => {
    const longDescription = "x".repeat(3100);
    const jobs = extractedJobs.map((job, index) =>
      index === 0
        ? {
            ...job,
            url: "https://nao-canonica.example/job/999",
            description: longDescription,
          }
        : job,
    );
    const { page } = makeGupyPage({ cardHtmlPages: [jobCards] });
    const { extractor } = createExtractor([jobs]);
    const { logger } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(extractor, true, logger).fetchPosts(
      SOURCE_URL,
    );

    expect(posts).toHaveLength(extractedJobs.length);
    expect(posts[0].id).toBe(`gupy:${jobs[0].id}`);
    expect(posts[0].url).toBe(`https://portal.gupy.io/job/${jobs[0].id}`);
    expect(posts[0].texto).toContain(`Título: ${jobs[0].title}`);
    expect(posts[0].texto).toContain(`Empresa: ${jobs[0].company}`);
    expect(posts[0].texto).toContain(`Localização: ${jobs[0].location}`);
    expect(posts[0].texto).toContain("Modalidade: hibrido");
    expect(posts[0].texto).toContain("Tipo: estagio");
    expect(posts[0].texto).toContain(`Publicado: ${jobs[0].publishedDate}`);
    expect(posts[0].texto).toContain(`Descrição: ${"x".repeat(3000)}`);
    expect(posts[0].texto).not.toContain("x".repeat(3001));

    const talentPool = posts.find((post) => post.id === "gupy:12916493");
    expect(talentPool?.texto).toContain("Tipo: banco de talentos");
    expect(talentPool?.texto).toContain("Modalidade: presencial");

    const onsite = posts.find((post) => post.id === "gupy:12855594");
    expect(onsite?.texto).toContain("Modalidade: presencial");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("descobre cards por links /job/ e envia o outerHTML para o extrator", async () => {
    const { page } = makeGupyPage({ cardHtmlPages: [jobCards] });
    const { extractor, extractJobs } = createExtractor([extractedJobs]);
    const { logger } = createCapturingLogger();

    await new GupyPlaywrightScraper(extractor, true, logger).fetchPosts(SOURCE_URL);

    expect(page.waitForSelector).toHaveBeenCalledWith(JOB_LINK_SELECTOR, expect.anything());
    expect(page.$$eval).toHaveBeenCalledWith(JOB_LINK_SELECTOR, expect.any(Function));
    expect(extractJobs).toHaveBeenCalledWith(jobCards, SOURCE_URL);

    const selectors = page.$$eval.mock.calls.map((call) => call[0]);
    expect(selectors).not.toContain(LEGACY_CARD_SELECTOR);
  });

  it("faz fallback para os seletores legados e loga quando a extração falha", async () => {
    const { page } = makeGupyPage({
      cardHtmlPages: [jobCards],
      legacyJobs: [legacyJob],
    });
    const extractJobs = vi.fn(
      async (_chunks: string[], _url: string): Promise<ExtractedJob[]> => {
        throw new Error("Gemini indisponível");
      },
    );
    const { logger, calls } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(
      { extractJobs },
      true,
      logger,
    ).fetchPosts(SOURCE_URL);

    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe("gupy:999");
    expect(posts[0].url).toBe("https://acme.gupy.io/job/999");
    expect(posts[0].texto).toContain("Título: Estágio Legado");

    const selectors = page.$$eval.mock.calls.map((call) => call[0]);
    expect(selectors).toContain(LEGACY_CARD_SELECTOR);

    const warning = calls.find((call) => call.level === "warn");
    expect(warning?.fields).toMatchObject({ page: 0, cardsIn: jobCards.length });

    const summary = calls.find(
      (call) => call.level === "info" && call.msg === "llm_extraction",
    );
    expect(summary?.fields).toMatchObject({
      page: 0,
      cardsIn: jobCards.length,
      jobsOut: 1,
      fallbackUsed: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("não chama o extrator quando useLLM=false e usa o caminho legado", async () => {
    const { page } = makeGupyPage({
      cardHtmlPages: [jobCards],
      legacyJobs: [legacyJob],
    });
    const { extractor, extractJobs } = createExtractor([extractedJobs]);
    const { logger, calls } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(extractor, false, logger).fetchPosts(
      SOURCE_URL,
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe("gupy:999");
    expect(extractJobs).not.toHaveBeenCalled();

    const selectors = page.$$eval.mock.calls.map((call) => call[0]);
    expect(selectors).toContain(LEGACY_CARD_SELECTOR);
    expect(selectors).not.toContain(JOB_LINK_SELECTOR);
    expect(calls.some((call) => call.msg === "llm_extraction")).toBe(false);
  });

  it("sem extrator, mesmo com useLLM=true, usa o caminho legado", async () => {
    const { page } = makeGupyPage({ legacyJobs: [legacyJob] });
    const { logger } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(undefined, true, logger).fetchPosts(
      SOURCE_URL,
    );

    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe("gupy:999");

    const selectors = page.$$eval.mock.calls.map((call) => call[0]);
    expect(selectors).toContain(LEGACY_CARD_SELECTOR);
    expect(selectors).not.toContain(JOB_LINK_SELECTOR);
  });
});

describe("GupyPlaywrightScraper shadow com hrefs reais (token base64)", () => {
  it("deriva o id numérico do token base64 do href real e casa com o id do LLM", async () => {
    const realHref = realCardHrefs[0];
    // O href real usa token base64, não um id numérico em texto claro.
    expect(realHref).toMatch(/\/job\/[A-Za-z0-9_-]{8,}/);
    expect(realHref).not.toMatch(/\/job\/\d+/);

    const { page } = makeGupyPage({
      cardHtmlPages: [jobCards],
      legacyCards: [fakeLegacyCard({ href: realHref, title: "Estágio em Direito | Bancário" })],
    });
    // Mesmo card real: o token decodifica para {"jobId":12916776,...}.
    const llmJob = extractedJobs[0];
    expect(llmJob.id).toBe("12916776");
    const { extractor } = createExtractor([[llmJob]]);
    const { logger, calls } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(extractor, false, logger, true).fetchPosts(
      SOURCE_URL,
    );

    // Antes da correção o id legado seria o href inteiro (o token não casa com
    // /\/job\/(\d+)/) e matched nunca passaria de 0 em páginas reais.
    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe(`gupy:${llmJob.id}`);
    expect(posts[0].url).toBe(realHref);

    const shadow = calls.find((call) => call.msg === "shadow");
    expect(shadow?.fields).toMatchObject({
      shadow: true,
      page: 0,
      cardsLegacy: 1,
      cardsLlm: 1,
    });
    expect(shadow?.fields?.matched).toBeGreaterThanOrEqual(1);
    expect(shadow?.fields?.idsOnlyLegacy).not.toContain(llmJob.id);
    expect(shadow?.fields?.idsOnlyLlm).not.toContain(llmJob.id);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("não lança em token inválido e mantém o href como id (fallback legado)", async () => {
    const brokenHref = "https://acme.gupy.io/job/!!!not-base64!!!";
    const { page } = makeGupyPage({
      legacyCards: [fakeLegacyCard({ href: brokenHref, title: "Vaga Legado" })],
    });
    const { logger } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(undefined, false, logger).fetchPosts(SOURCE_URL);

    expect(posts).toHaveLength(1);
    expect(posts[0].id).toBe(`gupy:${brokenHref}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GupyPlaywrightScraper paginação em modo LLM", () => {
  it("processa uma única página quando não há próxima página", async () => {
    const { page, state } = makeGupyPage({
      cardHtmlPages: [jobCards],
      maxNextClicks: 0,
    });
    const { extractor, extractJobs } = createExtractor([[extractedJobs[0]]]);
    const { logger } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(extractor, true, logger).fetchPosts(
      SOURCE_URL,
    );

    expect(posts.map((post) => post.id)).toEqual([`gupy:${extractedJobs[0].id}`]);
    expect(extractJobs).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(state.discoveryCalls).toBe(1);
  });

  it("deduplica por id quando a mesma vaga aparece em duas páginas", async () => {
    const firstJob = extractedJobs[0];
    const secondJob = extractedJobs[1];
    const { page, state } = makeGupyPage({
      cardHtmlPages: [jobCards, jobCards],
      maxNextClicks: 1,
    });
    const { extractor, extractJobs } = createExtractor([
      [firstJob],
      [firstJob, secondJob],
    ]);
    const { logger } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(extractor, true, logger).fetchPosts(
      SOURCE_URL,
    );

    expect(extractJobs).toHaveBeenCalledTimes(2);
    expect(state.discoveryCalls).toBe(2);
    expect(posts.map((post) => post.id)).toEqual([
      `gupy:${firstJob.id}`,
      `gupy:${secondJob.id}`,
    ]);
    expect(new Set(posts.map((post) => post.id)).size).toBe(posts.length);
    expect(page.waitForTimeout).toHaveBeenCalled();
  });

  it("respeita GUPY_MAX_PAGES ao paginar", async () => {
    process.env.GUPY_MAX_PAGES = "1";
    const { state } = makeGupyPage({
      cardHtmlPages: [jobCards, jobCards, jobCards],
      maxNextClicks: 5,
    });
    const { extractor, extractJobs } = createExtractor([
      [extractedJobs[0]],
      [extractedJobs[1]],
      [extractedJobs[2]],
    ]);
    const { logger } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(extractor, true, logger).fetchPosts(
      SOURCE_URL,
    );

    expect(extractJobs).toHaveBeenCalledTimes(1);
    expect(state.discoveryCalls).toBe(1);
    expect(posts).toHaveLength(1);
  });
});

describe("GupySource buildSearchUrl (addendum ticket 02)", () => {
  it("usa o termo como segmento de caminho e mantém os filtros na query string", async () => {
    const capturedUrls: string[] = [];
    const scraper = {
      fetchPosts: vi.fn(async (url: string) => {
        capturedUrls.push(url);
        return [];
      }),
    };
    const config: GupySearchConfig = {
      source: "gupy",
      profiles: [
        {
          name: "florianopolis-sc",
          state: "SC",
          cities: ["Florianópolis"],
          workplaceTypes: ["remote"],
          jobTypes: ["vacancy_type_internship"],
        },
      ],
      terms: ["estágio"],
    };
    const logger = createCapturingLogger().logger;

    await new GupySource(config, scraper, logger).fetchPosts();

    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe(
      "https://portal.gupy.io/job-search/term=est%C3%A1gio?state=SC&city%5B%5D=Florian%C3%B3polis&workplaceTypes%5B%5D=remote&jobTypes%5B%5D=vacancy_type_internship",
    );
  });
});
