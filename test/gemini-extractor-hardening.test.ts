import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiExtractor, estimateCostUsd } from "../src/gemini-extractor.js";
import type { ExtractedJob } from "../src/gemini-extractor.js";
import type { LogFields, Logger } from "../src/logger.js";

const ENV_KEYS = [
  "GEMINI_EXTRACTION_MODEL",
  "GEMINI_EXTRACTION_MAX_TOKENS",
  "GEMINI_EXTRACTION_BATCH_SIZE",
  "GEMINI_TIMEOUT_MS",
  "GEMINI_INPUT_COST_PER_MILLION",
  "GEMINI_OUTPUT_COST_PER_MILLION",
] as const;

const SOURCE_URL = "https://portal.gupy.io/job-search/term=estagio";

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/gupy/${name}`, import.meta.url), "utf8");
}

const jobCards = JSON.parse(readFixture("job-cards-real.json")) as string[];

interface GeminiRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

interface GeminiPromptBody {
  contents: { role?: string; parts: { text: string }[] }[];
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
}

interface GeminiHttpResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

type GeminiFetchMock = ReturnType<
  typeof vi.fn<(url: string, init: GeminiRequestInit) => Promise<GeminiHttpResponse>>
>;

function geminiResponse(text: string, usage?: GeminiUsage): GeminiHttpResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
      usageMetadata: usage,
    }),
  };
}

function jobsResponse(jobs: unknown[], usage?: GeminiUsage): GeminiHttpResponse {
  return geminiResponse(JSON.stringify(jobs), usage);
}

function createFetchMock(): GeminiFetchMock {
  return vi.fn<(url: string, init: GeminiRequestInit) => Promise<GeminiHttpResponse>>();
}

function requestBody(fetchMock: GeminiFetchMock, index = 0): GeminiPromptBody {
  return JSON.parse(fetchMock.mock.calls[index][1].body) as GeminiPromptBody;
}

function userPrompt(fetchMock: GeminiFetchMock, index = 0): string {
  return requestBody(fetchMock, index).contents[0].parts[0].text;
}

function makeJob(index: number): ExtractedJob {
  const id = String(2000 + index);
  return {
    id,
    title: `Vaga ${index}`,
    company: "Acme",
    location: "Florianópolis/SC",
    workplaceType: "remote",
    jobType: "internship",
    publishedDate: "2026-11-18T00:00:00-03:00",
    description: `Descrição da vaga ${index}`,
    url: `https://portal.gupy.io/job/${id}`,
  };
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

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("GeminiExtractor hardening: per-job normalization", () => {
  it("normalizes unknown workplaceType/jobType to unknown and keeps the job", async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse([{ ...makeJob(0), workplaceType: "presencial", jobType: "clt" }]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].workplaceType).toBe("unknown");
    expect(jobs[0].jobType).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops only jobs missing id or title, keeping the rest of the batch", async () => {
    const withoutTitle: Record<string, unknown> = { ...makeJob(1) };
    delete withoutTitle.title;
    const withoutId: Record<string, unknown> = { ...makeJob(2) };
    delete withoutId.id;
    const emptyTitle = { ...makeJob(3), title: "   " };

    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse([makeJob(0), withoutTitle, withoutId, emptyTitle, makeJob(4)]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toEqual([makeJob(0), makeJob(4)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const dropped = calls.filter((call) => call.msg === "dropped_invalid_job");
    expect(dropped).toHaveLength(3);
    expect(dropped.map((call) => call.fields?.index)).toEqual([1, 2, 3]);
    expect(dropped[0].fields?.reason).toMatch(/title/);
    expect(dropped[1].fields?.reason).toMatch(/id/);
    expect(dropped[2].fields?.reason).toMatch(/title/);
    for (const call of dropped) {
      expect(call.fields?.batchIndex).toBe(0);
    }
  });

  it("drops non-object entries without failing the batch", async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse([makeJob(0), null, "not-a-job", 42, makeJob(1)]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toEqual([makeJob(0), makeJob(1)]);
    const dropped = calls.filter((call) => call.msg === "dropped_invalid_job");
    expect(dropped.map((call) => call.fields?.index)).toEqual([1, 2, 3]);
  });

  it("canonicalizes a url that does not reference the job id and clears an unparseable date", async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse([
        {
          ...makeJob(0),
          url: "https://portal.gupy.io/job/999999",
          publishedDate: "ontem",
        },
        { ...makeJob(1), url: "", publishedDate: "" },
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toHaveLength(2);
    expect(jobs[0].url).toBe("https://portal.gupy.io/job/2000");
    expect(jobs[0].publishedDate).toBe("unknown");
    expect(jobs[1].url).toBe("https://portal.gupy.io/job/2001");
    expect(jobs[1].publishedDate).toBe("unknown");
  });

  it("coerces missing non-essential string fields to empty strings", async () => {
    const sparse: Record<string, unknown> = {
      id: makeJob(0).id,
      title: makeJob(0).title,
    };
    const fetchMock = createFetchMock().mockResolvedValue(jobsResponse([sparse]));
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      company: "",
      location: "",
      description: "",
      workplaceType: "unknown",
      jobType: "unknown",
      publishedDate: "unknown",
      url: `https://portal.gupy.io/job/${makeJob(0).id}`,
    });
  });
});

describe("GeminiExtractor hardening: corrective retries", () => {
  it("retries invalid JSON then succeeds with the corrective prompt", async () => {
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce(geminiResponse("não consigo extrair"))
      .mockResolvedValueOnce(jobsResponse([makeJob(0)]));
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);
    const jobs = await extractor.extractJobs([jobCards[0], jobCards[1]], SOURCE_URL);

    expect(jobs).toEqual([makeJob(0)]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(userPrompt(fetchMock, 1)).toContain("A resposta anterior falhou");
    expect(userPrompt(fetchMock, 1)).toContain("Retorne APENAS um JSON array válido");

    const successLog = calls.find((call) => call.msg === "gupy extraction batch succeeded");
    expect(successLog?.fields).toMatchObject({
      batchIndex: 0,
      cardsIn: 2,
      jobsOut: 1,
      dropped: 0,
      retryCount: 1,
      success: true,
    });
  });

  it("does not retry when jobs are individually dropped", async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse([{ ...makeJob(0), id: "not-numeric" }, makeJob(1)]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toEqual([makeJob(1)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("GeminiExtractor hardening: timeout", () => {
  it("aborts the Gemini call and rejects the batch with a clear timeout error", async () => {
    process.env.GEMINI_TIMEOUT_MS = "5";
    const fetchMock = vi.fn(
      (_url: string, init: GeminiRequestInit) =>
        new Promise<GeminiHttpResponse>((_resolve, reject) => {
          const signal = init.signal;
          if (!signal) {
            reject(new Error("fetch called without an abort signal"));
            return;
          }
          signal.addEventListener(
            "abort",
            () => reject(new Error("The operation was aborted due to timeout")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);

    await expect(extractor.extractJobs([jobCards[0]], SOURCE_URL)).rejects.toThrow(
      /timed out after 5ms/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const failureLog = calls.find((call) => call.level === "error");
    expect(failureLog?.fields).toMatchObject({
      batchIndex: 0,
      cardsIn: 1,
      jobsOut: 0,
      retryCount: 0,
      success: false,
    });
    expect(String(failureLog?.fields?.error)).toMatch(/timed out/);
  });
});

describe("GeminiExtractor hardening: aggregated metrics", () => {
  it("logs one run summary with batches, jobs, dropped jobs, tokens and cost", async () => {
    process.env.GEMINI_EXTRACTION_BATCH_SIZE = "2";
    const chunks = Array.from({ length: 5 }, (_, index) => `<li>card ${index}</li>`);

    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse(
        [makeJob(0), { ...makeJob(1), id: "invalid" }],
        { promptTokenCount: 100, candidatesTokenCount: 50 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);
    const jobs = await extractor.extractJobs(chunks, SOURCE_URL);

    expect(jobs).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const batchLogs = calls.filter((call) => call.msg === "gupy extraction batch succeeded");
    expect(batchLogs).toHaveLength(3);
    for (const [index, call] of batchLogs.entries()) {
      expect(call.fields).toMatchObject({
        batchIndex: index,
        cardsIn: index < 2 ? 2 : 1,
        jobsOut: 1,
        dropped: 1,
        inputTokens: 100,
        outputTokens: 50,
        retryCount: 0,
        success: true,
      });
    }

    const summaries = calls.filter((call) => call.msg === "gupy extraction run summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].level).toBe("info");
    expect(summaries[0].fields).toMatchObject({
      totalBatches: 3,
      totalJobs: 3,
      totalDropped: 3,
      totalTokens: 450,
    });
    expect(summaries[0].fields?.estimatedCostUsd).toBeCloseTo(0.0000675, 12);
  });

  it("uses configurable pricing for the estimated cost", async () => {
    process.env.GEMINI_INPUT_COST_PER_MILLION = "1";
    process.env.GEMINI_OUTPUT_COST_PER_MILLION = "2";
    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse([makeJob(0)], { promptTokenCount: 500_000, candidatesTokenCount: 250_000 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);
    await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    const summary = calls.find((call) => call.msg === "gupy extraction run summary");
    expect(summary?.fields?.estimatedCostUsd).toBeCloseTo(1, 12);
  });
});

describe("GeminiExtractor hardening: constructor options", () => {
  it("explicit batchSize option wins over GEMINI_EXTRACTION_BATCH_SIZE env", async () => {
    process.env.GEMINI_EXTRACTION_BATCH_SIZE = "1";
    const chunks = Array.from({ length: 4 }, (_, index) => `<li>card ${index}</li>`);
    const fetchMock = createFetchMock().mockResolvedValue(jobsResponse([makeJob(0)]));
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key", undefined, undefined, { batchSize: 3 });
    await extractor.extractJobs(chunks, SOURCE_URL);

    // env=1 alone would mean 4 fetch calls; the explicit option of 3 means 2 (3+1).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("explicit maxOutputTokens option wins over GEMINI_EXTRACTION_MAX_TOKENS env", async () => {
    process.env.GEMINI_EXTRACTION_MAX_TOKENS = "111";
    const fetchMock = createFetchMock().mockResolvedValue(jobsResponse([makeJob(0)]));
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key", undefined, undefined, {
      maxOutputTokens: 4096,
    });
    await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body) as {
      generationConfig: { maxOutputTokens: number };
    };
    expect(body.generationConfig.maxOutputTokens).toBe(4096);
  });
});

describe("estimateCostUsd", () => {
  it("computes cost from per-million token pricing independently of the extractor", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000)).toBeCloseTo(0.375, 12);
    expect(
      estimateCostUsd(2_000_000, 500_000, {
        inputCostPerMillionUsd: 0.1,
        outputCostPerMillionUsd: 0.4,
      }),
    ).toBeCloseTo(0.4, 12);
    expect(estimateCostUsd(0, 0)).toBe(0);
  });
});
