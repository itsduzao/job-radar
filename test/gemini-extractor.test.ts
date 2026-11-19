import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiExtractor } from "../src/gemini-extractor.js";
import type { ExtractedJob } from "../src/gemini-extractor.js";
import type { LogFields, Logger } from "../src/logger.js";

const ENV_KEYS = [
  "GEMINI_EXTRACTION_MODEL",
  "GEMINI_EXTRACTION_MAX_TOKENS",
  "GEMINI_EXTRACTION_BATCH_SIZE",
] as const;

const SOURCE_URL = "https://portal.gupy.io/job-search?term=estagio";

function readFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/gupy/${name}`, import.meta.url), "utf8");
}

const extractedJobs = JSON.parse(readFixture("extracted-jobs-real.json")) as ExtractedJob[];
const jobCards = JSON.parse(readFixture("job-cards-real.json")) as string[];
const searchPageHtml = readFixture("search-page-real.html");

interface GeminiRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface GeminiPromptBody {
  systemInstruction: { parts: { text: string }[] };
  contents: { role?: string; parts: { text: string }[] }[];
  generationConfig: { maxOutputTokens?: number };
}

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
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

function jobsResponse(jobs: ExtractedJob[], usage?: GeminiUsage): GeminiHttpResponse {
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
  const id = String(1000 + index);
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

describe("GeminiExtractor.extractJobs", () => {
  it("extracts validated jobs from a full search page using the default model and prompt", async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse(extractedJobs, { promptTokenCount: 1200, candidatesTokenCount: 800 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([searchPageHtml], SOURCE_URL);

    expect(jobs).toEqual(extractedJobs);
    expect(globalThis.fetch).toBe(fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=test-key",
    );

    const body = requestBody(fetchMock);
    expect(body.generationConfig.maxOutputTokens).toBe(8000);
    expect(body.systemInstruction.parts[0].text).toContain(
      "extrator de vagas do portal.gupy.io",
    );
    expect(body.systemInstruction.parts[0].text).not.toContain("--- SYSTEM ---");

    const prompt = userPrompt(fetchMock);
    expect(prompt).toContain("__NEXT_DATA__");
    expect(prompt).toContain(SOURCE_URL);
    expect(prompt).not.toContain("{html}");
    expect(prompt).not.toContain("{sourceUrl}");
  });

  it("tolerates markdown code fences around the JSON array", async () => {
    const fenced = ["```json", JSON.stringify(extractedJobs), "```"].join("\n");
    const fetchMock = createFetchMock().mockResolvedValue(geminiResponse(fenced));
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toEqual(extractedJobs);
  });

  it("retries with corrective feedback when the first answer is not valid JSON", async () => {
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce(geminiResponse("Desculpe, não foi possível extrair as vagas."))
      .mockResolvedValueOnce(jobsResponse(extractedJobs));
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toEqual(extractedJobs);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const retryPrompt = userPrompt(fetchMock, 1);
    expect(retryPrompt).toContain("A resposta anterior falhou");
    expect(retryPrompt).toContain("Retorne APENAS um JSON array válido");
    expect(retryPrompt).toContain(jobCards[0]);
  });

  it("chunks 25 inputs into batches of 10 and preserves order", async () => {
    process.env.GEMINI_EXTRACTION_BATCH_SIZE = "10";
    const chunks = Array.from(
      { length: 25 },
      (_, index) => `<li data-card-index="${index}">vaga ${index}</li>`,
    );

    const fetchMock = createFetchMock().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body) as GeminiPromptBody;
      const prompt = body.contents[0].parts[0].text;
      const cardIndexes = [...prompt.matchAll(/data-card-index="(\d+)"/g)].map((match) =>
        Number(match[1]),
      );
      return jobsResponse(cardIndexes.map(makeJob));
    });
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs(chunks, SOURCE_URL);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(jobs.map((job) => job.title)).toEqual(
      Array.from({ length: 25 }, (_, index) => `Vaga ${index}`),
    );

    const batchedIndexes = fetchMock.mock.calls.map((_call, index) =>
      [...userPrompt(fetchMock, index).matchAll(/data-card-index="(\d+)"/g)].map((match) =>
        Number(match[1]),
      ),
    );
    expect(batchedIndexes).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
      [20, 21, 22, 23, 24],
    ]);
  });

  it("keeps talent pool jobs with jobType talent_pool", async () => {
    const talentPoolJob = extractedJobs.find((job) => job.jobType === "talent_pool");
    expect(talentPoolJob).toBeDefined();
    const fetchMock = createFetchMock().mockResolvedValue(jobsResponse([talentPoolJob!]));
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[2]], SOURCE_URL);

    expect(jobs).toEqual([talentPoolJob]);
    expect(jobs[0].jobType).toBe("talent_pool");
  });

  it("drops only the job with a missing required field instead of failing the batch", async () => {
    const invalidJob: Record<string, unknown> = { ...makeJob(1) };
    delete invalidJob.title;
    const fetchMock = createFetchMock().mockResolvedValue(
      geminiResponse(JSON.stringify([makeJob(0), invalidJob])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toEqual([makeJob(0)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const droppedLog = calls.find((call) => call.msg === "dropped_invalid_job");
    expect(droppedLog?.fields).toMatchObject({ batchIndex: 0, index: 1 });
    expect(String(droppedLog?.fields?.reason)).toMatch(/title/);
  });

  it("normalizes an enum field outside the allowed values to unknown", async () => {
    const invalidJob = { ...makeJob(0), workplaceType: "presencial" };
    const fetchMock = createFetchMock().mockResolvedValue(
      geminiResponse(JSON.stringify([invalidJob])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].workplaceType).toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops a job whose id is not numeric", async () => {
    const invalidJob = { ...makeJob(0), id: "abc123" };
    const fetchMock = createFetchMock().mockResolvedValue(
      geminiResponse(JSON.stringify([invalidJob])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const droppedLog = calls.find((call) => call.msg === "dropped_invalid_job");
    expect(String(droppedLog?.fields?.reason)).toMatch(/id/);
  });

  it("retries transient 5xx errors and fails after exhausting attempts", async () => {
    const fetchMock = createFetchMock().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");

    await expect(extractor.extractJobs([jobCards[0]], SOURCE_URL)).rejects.toThrow("500");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries a transient 503 and succeeds on the next attempt", async () => {
    const fetchMock = createFetchMock()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce(jobsResponse(extractedJobs));
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    expect(jobs).toEqual(extractedJobs);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-transient API errors such as 404", async () => {
    const fetchMock = createFetchMock().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");

    await expect(extractor.extractJobs([jobCards[0]], SOURCE_URL)).rejects.toThrow("404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns an empty array without calling Gemini when there are no chunks", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    const jobs = await extractor.extractJobs([], SOURCE_URL);

    expect(jobs).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours the model and max output tokens environment overrides", async () => {
    process.env.GEMINI_EXTRACTION_MODEL = "gemini-2.0-flash";
    process.env.GEMINI_EXTRACTION_MAX_TOKENS = "2048";
    const fetchMock = createFetchMock().mockResolvedValue(jobsResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const extractor = new GeminiExtractor("test-key");
    await extractor.extractJobs([jobCards[0]], SOURCE_URL);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=test-key",
    );
    expect(requestBody(fetchMock).generationConfig.maxOutputTokens).toBe(2048);
  });

  it("logs batch index, card and job counts, tokens, latency and retry count", async () => {
    const fetchMock = createFetchMock().mockResolvedValue(
      jobsResponse(extractedJobs, { promptTokenCount: 1234, candidatesTokenCount: 567 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { logger, calls } = createCapturingLogger();

    const extractor = new GeminiExtractor("test-key", undefined, logger);
    await extractor.extractJobs([jobCards[0], jobCards[1]], SOURCE_URL);

    expect(calls).toHaveLength(2);
    expect(calls[0].level).toBe("info");
    expect(calls[0].fields).toMatchObject({
      batchIndex: 0,
      cardsIn: 2,
      jobsOut: 5,
      inputTokens: 1234,
      outputTokens: 567,
      retryCount: 0,
      success: true,
    });
    expect(typeof calls[0].fields?.latencyMs).toBe("number");
  });
});
