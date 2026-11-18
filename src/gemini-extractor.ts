import { readFileSync } from "node:fs";
import type { Logger } from "./logger.js";

export type WorkplaceType = "remote" | "onSite" | "hybrid" | "unknown";
export type JobType = "internship" | "trainee" | "effective" | "talent_pool" | "unknown";

export interface ExtractedJob {
  id: string;
  title: string;
  company: string;
  location: string;
  workplaceType: WorkplaceType;
  jobType: JobType;
  publishedDate: string;
  description: string;
  url: string;
}

export interface JobExtractor {
  extractJobs(htmlChunks: string[], sourceUrl: string): Promise<ExtractedJob[]>;
}

export interface GeminiPricing {
  inputCostPerMillionUsd: number;
  outputCostPerMillionUsd: number;
}

const DEFAULT_MODEL = "gemini-1.5-flash";
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CORRECTIVE_RETRIES = 2;

// Public `gemini-1.5-flash` pricing (USD per million tokens), used when the
// operator does not override GEMINI_INPUT_COST_PER_MILLION / GEMINI_OUTPUT_COST_PER_MILLION.
export const DEFAULT_GEMINI_PRICING: GeminiPricing = {
  inputCostPerMillionUsd: 0.075,
  outputCostPerMillionUsd: 0.3,
};

const WORKPLACE_TYPES = ["remote", "onSite", "hybrid", "unknown"] as const;
const JOB_TYPES = ["internship", "trainee", "effective", "talent_pool", "unknown"] as const;

const PROMPT_URL = new URL("./prompts/gupy-extraction-v1.txt", import.meta.url);

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

interface PromptTemplate {
  system: string;
  user: string;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: GeminiUsageMetadata;
}

interface DroppedJob {
  index: number;
  reason: string;
}

interface NormalizedJobs {
  jobs: ExtractedJob[];
  dropped: DroppedJob[];
}

interface BatchResult extends NormalizedJobs {
  inputTokens: number;
  outputTokens: number;
}

/** Thrown when the model answered, but the answer is not usable output. */
class InvalidExtractionError extends Error {}

/** Thrown when the Gemini API itself fails (transport, auth, quota). */
class GeminiApiError extends Error {}

/** Thrown when a single Gemini call exceeds GEMINI_TIMEOUT_MS. */
class GeminiTimeoutError extends Error {}

let promptCache: PromptTemplate | undefined;

function parsePromptTemplate(raw: string): PromptTemplate {
  const lines = raw.split(/\r?\n/);
  const systemMarker = lines.findIndex((line) => line.trim() === "--- SYSTEM ---");
  const userMarker = lines.findIndex((line) => line.trim() === "--- USER ---");
  if (systemMarker === -1 || userMarker === -1 || userMarker < systemMarker) {
    throw new Error("Invalid Gupy extraction prompt: missing --- SYSTEM --- or --- USER --- markers");
  }
  return {
    system: lines.slice(systemMarker + 1, userMarker).join("\n").trim(),
    user: lines.slice(userMarker + 1).join("\n").trim(),
  };
}

function loadPromptTemplate(): PromptTemplate {
  if (!promptCache) {
    promptCache = parsePromptTemplate(readFileSync(PROMPT_URL, "utf8"));
  }
  return promptCache;
}

function renderUserPrompt(template: string, html: string, sourceUrl: string): string {
  return template.replaceAll("{html}", html).replaceAll("{sourceUrl}", sourceUrl);
}

function correctivePrompt(basePrompt: string, reason: string): string {
  const cleanReason = reason.replace(/[.\s]+$/, "");
  return `${basePrompt}\n\nA resposta anterior falhou: ${cleanReason}. Retorne APENAS um JSON array válido, sem markdown, sem explicações.`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function positiveIntFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumberFromEnv(name: string, fallback: number): number {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isWorkplaceType(value: string): value is WorkplaceType {
  return (WORKPLACE_TYPES as readonly string[]).includes(value);
}

function isJobType(value: string): value is JobType {
  return (JOB_TYPES as readonly string[]).includes(value);
}

/** Removes optional markdown code fences and surrounding whitespace. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

function parseJobsJson(text: string): unknown {
  try {
    return JSON.parse(stripCodeFences(text));
  } catch {
    throw new InvalidExtractionError("a resposta não é um JSON válido");
  }
}

/**
 * Normalizes one raw model entry. Returns a job, or a drop reason when the
 * entry cannot be used for dedupe/digest (missing/invalid id or title).
 * Everything else is defensively coerced so one bad field never sinks a batch.
 */
function normalizeJob(value: unknown, index: number): ExtractedJob | DroppedJob {
  if (!isRecord(value)) {
    return { index, reason: `job[${index}] não é um objeto` };
  }

  const id = value.id;
  if (typeof id !== "string" || !/^\d+$/.test(id)) {
    return { index, reason: `job[${index}].id ausente ou inválido (esperado apenas dígitos)` };
  }

  const title = value.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return { index, reason: `job[${index}].title ausente ou vazio` };
  }

  const company = typeof value.company === "string" ? value.company : "";
  const location = typeof value.location === "string" ? value.location : "";
  const description = typeof value.description === "string" ? value.description : "";

  const workplaceType =
    typeof value.workplaceType === "string" && isWorkplaceType(value.workplaceType)
      ? value.workplaceType
      : "unknown";

  const jobType =
    typeof value.jobType === "string" && isJobType(value.jobType) ? value.jobType : "unknown";

  const rawUrl = typeof value.url === "string" ? value.url : "";
  const url = rawUrl.includes(`/job/${id}`) ? rawUrl : `https://portal.gupy.io/job/${id}`;

  const rawPublishedDate = typeof value.publishedDate === "string" ? value.publishedDate : "";
  const publishedDate = Number.isNaN(Date.parse(rawPublishedDate)) ? "unknown" : rawPublishedDate;

  return {
    id,
    title,
    company,
    location,
    workplaceType,
    jobType,
    publishedDate,
    description,
    url,
  };
}

function isDroppedJob(value: ExtractedJob | DroppedJob): value is DroppedJob {
  return "reason" in value;
}

function normalizeJobs(value: unknown): NormalizedJobs {
  if (!Array.isArray(value)) {
    throw new InvalidExtractionError("a resposta não é um JSON array");
  }

  const jobs: ExtractedJob[] = [];
  const dropped: DroppedJob[] = [];
  value.forEach((item, index) => {
    const normalized = normalizeJob(item, index);
    if (isDroppedJob(normalized)) {
      dropped.push(normalized);
    } else {
      jobs.push(normalized);
    }
  });

  return { jobs, dropped };
}

/**
 * Pure token-cost calculation. Pricing is USD per million tokens so it can be
 * fed straight from GEMINI_*_COST_PER_MILLION environment overrides.
 */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricing: GeminiPricing = DEFAULT_GEMINI_PRICING,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputCostPerMillionUsd +
    (outputTokens / 1_000_000) * pricing.outputCostPerMillionUsd
  );
}

export class GeminiExtractor implements JobExtractor {
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly pricing: GeminiPricing;
  private readonly logger: Logger;

  constructor(
    private readonly apiKey: string,
    model?: string,
    logger?: Logger,
  ) {
    this.model = model ?? process.env.GEMINI_EXTRACTION_MODEL ?? DEFAULT_MODEL;
    this.maxOutputTokens = positiveIntFromEnv(
      "GEMINI_EXTRACTION_MAX_TOKENS",
      DEFAULT_MAX_TOKENS,
    );
    this.batchSize = positiveIntFromEnv("GEMINI_EXTRACTION_BATCH_SIZE", DEFAULT_BATCH_SIZE);
    this.timeoutMs = positiveIntFromEnv("GEMINI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    this.pricing = {
      inputCostPerMillionUsd: positiveNumberFromEnv(
        "GEMINI_INPUT_COST_PER_MILLION",
        DEFAULT_GEMINI_PRICING.inputCostPerMillionUsd,
      ),
      outputCostPerMillionUsd: positiveNumberFromEnv(
        "GEMINI_OUTPUT_COST_PER_MILLION",
        DEFAULT_GEMINI_PRICING.outputCostPerMillionUsd,
      ),
    };
    this.logger = logger ?? noopLogger;
  }

  async extractJobs(htmlChunks: string[], sourceUrl: string): Promise<ExtractedJob[]> {
    const template = loadPromptTemplate();
    const jobs: ExtractedJob[] = [];
    const batches = chunkArray(htmlChunks, this.batchSize);

    let totalDropped = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let success = true;

    try {
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
        const batch = await this.extractBatch(
          batches[batchIndex],
          sourceUrl,
          template,
          batchIndex,
        );
        jobs.push(...batch.jobs);
        totalDropped += batch.dropped.length;
        totalInputTokens += batch.inputTokens;
        totalOutputTokens += batch.outputTokens;
      }
      return jobs;
    } catch (err) {
      success = false;
      throw err;
    } finally {
      const totalTokens = totalInputTokens + totalOutputTokens;
      this.logger.info("gupy extraction run summary", {
        totalBatches: batches.length,
        totalJobs: jobs.length,
        totalDropped,
        totalTokens,
        estimatedCostUsd: estimateCostUsd(
          totalInputTokens,
          totalOutputTokens,
          this.pricing,
        ),
        success,
      });
    }
  }

  private async extractBatch(
    chunk: string[],
    sourceUrl: string,
    template: PromptTemplate,
    batchIndex: number,
  ): Promise<BatchResult> {
    const startedAt = Date.now();
    const basePrompt = renderUserPrompt(template.user, chunk.join("\n---\n"), sourceUrl);
    let lastReason = "a resposta anterior não passou na validação";

    for (let attempt = 0; attempt <= MAX_CORRECTIVE_RETRIES; attempt++) {
      const prompt = attempt === 0 ? basePrompt : correctivePrompt(basePrompt, lastReason);

      let response: { text: string; usage?: GeminiUsageMetadata };
      try {
        response = await this.generate(template.system, prompt);
      } catch (err) {
        this.logger.error("gupy extraction call failed", {
          batchIndex,
          cardsIn: chunk.length,
          jobsOut: 0,
          dropped: 0,
          latencyMs: Date.now() - startedAt,
          retryCount: attempt,
          success: false,
          error: errorMessage(err),
        });
        throw err;
      }

      try {
        const { jobs, dropped } = normalizeJobs(parseJobsJson(response.text));
        for (const drop of dropped) {
          this.logger.warn("dropped_invalid_job", {
            batchIndex,
            index: drop.index,
            reason: drop.reason,
          });
        }

        const inputTokens = response.usage?.promptTokenCount ?? 0;
        const outputTokens = response.usage?.candidatesTokenCount ?? 0;
        this.logger.info("gupy extraction batch succeeded", {
          batchIndex,
          cardsIn: chunk.length,
          jobsOut: jobs.length,
          dropped: dropped.length,
          ...(response.usage?.promptTokenCount === undefined
            ? {}
            : { inputTokens: response.usage.promptTokenCount }),
          ...(response.usage?.candidatesTokenCount === undefined
            ? {}
            : { outputTokens: response.usage.candidatesTokenCount }),
          latencyMs: Date.now() - startedAt,
          retryCount: attempt,
          success: true,
        });
        return { jobs, dropped, inputTokens, outputTokens };
      } catch (err) {
        lastReason = errorMessage(err);
      }
    }

    const error = new Error(
      `Gemini extraction failed for batch ${batchIndex} after ${MAX_CORRECTIVE_RETRIES + 1} attempts: ${lastReason}`,
    );
    this.logger.error("gupy extraction batch failed", {
      batchIndex,
      cardsIn: chunk.length,
      jobsOut: 0,
      dropped: 0,
      latencyMs: Date.now() - startedAt,
      retryCount: MAX_CORRECTIVE_RETRIES,
      success: false,
      error: lastReason,
    });
    throw error;
  }

  private async generate(
    system: string,
    user: string,
  ): Promise<{ text: string; usage?: GeminiUsageMetadata }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const signal = AbortSignal.timeout(this.timeoutMs);

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: this.maxOutputTokens },
        }),
        signal,
      });
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        throw new GeminiTimeoutError(
          `Gemini generateContent timed out after ${this.timeoutMs}ms`,
        );
      }
      throw err;
    }

    if (!res.ok) {
      throw new GeminiApiError(`Gemini generateContent failed with status ${res.status}`);
    }
    const data = (await res.json()) as GeminiResponse;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new InvalidExtractionError("a resposta do Gemini não contém texto");
    }
    return { text, usage: data.usageMetadata };
  }
}
