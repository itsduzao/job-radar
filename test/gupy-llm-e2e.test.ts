import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GupyPlaywrightScraper } from "../src/playwright-scraper.js";
import type { ExtractedJob, JobExtractor } from "../src/gemini-extractor.js";
import type { LogFields, Logger } from "../src/logger.js";
import type { Post } from "../src/domain.js";

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

const MODALITY: Record<ExtractedJob["workplaceType"], string> = {
  remote: "remoto",
  onSite: "presencial",
  hybrid: "hibrido",
  unknown: "desconhecido",
};

const JOB_TYPE: Record<ExtractedJob["jobType"], string> = {
  internship: "estagio",
  trainee: "junior",
  effective: "junior",
  talent_pool: "banco de talentos",
  unknown: "desconhecido",
};

interface GupyPageState {
  cardHtmlPages: string[][];
  legacyJobs: LegacyJob[];
  maxNextClicks: number;
  nextClicks: number;
  discoveryCalls: number;
}

function makeGupyPage(overrides: Partial<GupyPageState> = {}) {
  const state: GupyPageState = {
    cardHtmlPages: [],
    legacyJobs: [],
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
    $$eval: vi.fn(async (selector: string) => {
      if (selector === JOB_LINK_SELECTOR) {
        const index = state.discoveryCalls;
        state.discoveryCalls += 1;
        return state.cardHtmlPages[index] ?? [];
      }
      return state.legacyJobs;
    }),
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

function legacyPost(job: LegacyJob): Post {
  return {
    id: `gupy:${job.id}`,
    url: job.url.startsWith("http") ? job.url : `https://portal.gupy.io${job.url}`,
    texto: [
      `Título: ${job.title}`,
      `Empresa: ${job.company}`,
      `Localização: ${job.location}`,
      `Modalidade: ${job.workplaceType}`,
      `Tipo: ${job.jobType}`,
      `Publicado: ${job.publishedDate}`,
      `Descrição: ${job.description.slice(0, 3000)}`,
    ].join("\n"),
  };
}

function extractedJob(overrides: Partial<ExtractedJob> & Pick<ExtractedJob, "id">): ExtractedJob {
  return {
    title: `Vaga ${overrides.id}`,
    company: "Acme",
    location: "Florianópolis/SC",
    workplaceType: "remote",
    jobType: "internship",
    publishedDate: "2026-11-18T00:00:00-03:00",
    description: "Descrição",
    url: `https://portal.gupy.io/job/${overrides.id}`,
    ...overrides,
  };
}

const legacyOverlap: LegacyJob = {
  id: "12916776",
  title: "Vaga Legada QCA",
  company: "Acme",
  location: "Florianópolis/SC",
  workplaceType: "remoto",
  jobType: "estagio",
  publishedDate: "2026-11-18T00:00:00-03:00",
  description: "Texto vindo dos seletores",
  url: "https://acme.gupy.io/job/12916776",
};

const legacyOnly: LegacyJob = {
  ...legacyOverlap,
  id: "999",
  title: "Vaga só dos seletores",
  url: "https://acme.gupy.io/job/999",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  launch.mockReset();
  fetchMock = vi.fn(() => {
    throw new Error("chamada de rede proibida no E2E offline");
  });
  vi.stubGlobal("fetch", fetchMock);
  delete process.env.GUPY_MAX_PAGES;
  delete process.env.GUPY_DRY_RUN;
  delete process.env.GUPY_LLM_SHADOW;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GUPY_MAX_PAGES;
  delete process.env.GUPY_DRY_RUN;
  delete process.env.GUPY_LLM_SHADOW;
});

describe("E2E offline da extração LLM", () => {
  it("produz Post[] completo a partir das fixtures reais, sem rede", async () => {
    const { page } = makeGupyPage({ cardHtmlPages: [jobCards] });
    const { extractor, extractJobs } = createExtractor([extractedJobs]);
    const { logger } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(extractor, true, logger).fetchPosts(
      SOURCE_URL,
    );

    expect(posts.map((post) => post.id)).toEqual(
      extractedJobs.map((job) => `gupy:${job.id}`),
    );
    expect(posts.map((post) => post.url)).toEqual(
      extractedJobs.map((job) => `https://portal.gupy.io/job/${job.id}`),
    );

    for (const job of extractedJobs) {
      const post = posts.find((candidate) => candidate.id === `gupy:${job.id}`);
      expect(post, `post ausente para ${job.id}`).toBeDefined();
      expect(post?.texto).toBe(
        [
          `Título: ${job.title}`,
          `Empresa: ${job.company}`,
          `Localização: ${job.location}`,
          `Modalidade: ${MODALITY[job.workplaceType]}`,
          `Tipo: ${JOB_TYPE[job.jobType]}`,
          `Publicado: ${job.publishedDate}`,
          `Descrição: ${job.description.slice(0, 3000)}`,
        ].join("\n"),
      );
    }

    const talentPool = posts.find((post) => post.id === "gupy:12916493");
    expect(talentPool?.texto).toContain("Tipo: banco de talentos");
    expect(talentPool?.texto).toContain("Modalidade: presencial");

    expect(extractJobs).toHaveBeenCalledWith(jobCards, SOURCE_URL);
    expect(page.waitForSelector).toHaveBeenCalledWith(JOB_LINK_SELECTOR, expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("para a paginação com segurança quando o LLM devolve zero vagas", async () => {
    const { page, state } = makeGupyPage({
      cardHtmlPages: [jobCards, jobCards],
      maxNextClicks: 3,
    });
    const { extractor, extractJobs } = createExtractor([[], extractedJobs]);
    const { logger } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(extractor, true, logger).fetchPosts(
      SOURCE_URL,
    );

    expect(posts).toEqual([]);
    expect(extractJobs).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(state.discoveryCalls).toBe(1);
    expect(state.nextClicks).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Modo shadow", () => {
  it("retorna a saída legacy e loga divergências de ids", async () => {
    const { page } = makeGupyPage({
      cardHtmlPages: [jobCards],
      legacyJobs: [legacyOverlap, legacyOnly],
    });
    const llmOverlap = extractedJob({
      id: "12916776",
      title: "Vaga vinda do LLM",
      workplaceType: "hybrid",
      jobType: "talent_pool",
      description: "Texto diferente do legacy",
    });
    const llmOnly = extractedJob({ id: "888", title: "Vaga só do LLM" });
    const { extractor, extractJobs } = createExtractor([[llmOverlap, llmOnly]]);
    const { logger, calls } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(
      extractor,
      false,
      logger,
      true,
    ).fetchPosts(SOURCE_URL);

    expect(posts).toEqual([legacyPost(legacyOverlap), legacyPost(legacyOnly)]);
    expect(extractJobs).toHaveBeenCalledTimes(1);

    const shadow = calls.find((call) => call.level === "info" && call.msg === "shadow");
    expect(shadow?.fields).toMatchObject({
      shadow: true,
      page: 0,
      cardsLegacy: 2,
      cardsLlm: 2,
      matched: 1,
      missed: 1,
      idsOnlyLegacy: ["999"],
      idsOnlyLlm: ["888"],
    });

    const selectors = page.$$eval.mock.calls.map((call) => call[0]);
    expect(selectors).toContain(JOB_LINK_SELECTOR);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mantém a saída legacy quando a extração LLM falha em shadow", async () => {
    const { page } = makeGupyPage({
      cardHtmlPages: [jobCards],
      legacyJobs: [legacyOverlap],
    });
    const extractJobs = vi.fn(
      async (_chunks: string[], _url: string): Promise<ExtractedJob[]> => {
        throw new Error("Gemini indisponível");
      },
    );
    const { logger, calls } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(
      { extractJobs },
      false,
      logger,
      true,
    ).fetchPosts(SOURCE_URL);

    expect(posts).toEqual([legacyPost(legacyOverlap)]);
    expect(extractJobs).toHaveBeenCalledTimes(1);

    const warning = calls.find((call) => call.level === "warn");
    expect(warning?.fields).toMatchObject({ page: 0, error: "Gemini indisponível" });

    const shadow = calls.find((call) => call.level === "info" && call.msg === "shadow");
    expect(shadow?.fields).toMatchObject({
      shadow: true,
      page: 0,
      cardsLegacy: 1,
      cardsLlm: 0,
      matched: 0,
      missed: 1,
      idsOnlyLegacy: ["12916776"],
      idsOnlyLlm: [],
    });
    expect(page.$$eval).toHaveBeenCalled();
  });

  it("detecta recall quando os seletores não encontram cards", async () => {
    const { page, state } = makeGupyPage({
      cardHtmlPages: [jobCards],
      legacyJobs: [],
      maxNextClicks: 2,
    });
    const { extractor, extractJobs } = createExtractor([
      [extractedJob({ id: "777" })],
    ]);
    const { logger, calls } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(
      extractor,
      false,
      logger,
      true,
    ).fetchPosts(SOURCE_URL);

    expect(posts).toEqual([]);
    expect(extractJobs).toHaveBeenCalledTimes(1);
    expect(state.nextClicks).toBe(0);

    const shadow = calls.find((call) => call.level === "info" && call.msg === "shadow");
    expect(shadow?.fields).toMatchObject({
      shadow: true,
      page: 0,
      cardsLegacy: 0,
      cardsLlm: 1,
      matched: 0,
      missed: 0,
      idsOnlyLegacy: [],
      idsOnlyLlm: ["777"],
    });
  });

  it("não chama o extrator quando shadow está desligado", async () => {
    const { page } = makeGupyPage({ legacyJobs: [legacyOverlap] });
    const { extractor, extractJobs } = createExtractor([extractedJobs]);
    const { logger, calls } = createCapturingLogger();

    const posts = await new GupyPlaywrightScraper(
      extractor,
      false,
      logger,
      false,
    ).fetchPosts(SOURCE_URL);

    expect(posts).toEqual([legacyPost(legacyOverlap)]);
    expect(extractJobs).not.toHaveBeenCalled();
    expect(calls.some((call) => call.msg === "shadow")).toBe(false);
    expect(page.$$eval.mock.calls.map((call) => call[0])).not.toContain(
      JOB_LINK_SELECTOR,
    );
  });
});
