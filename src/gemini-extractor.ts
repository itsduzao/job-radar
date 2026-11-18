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

const DEFAULT_MODEL = "gemini-1.5-flash";
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_BATCH_SIZE = 10;
const MAX_CORRECTIVE_RETRIES = 2;

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

/** Thrown when the model answered, but the answer is not usable output. */
class InvalidExtractionError extends Error {}

/** Thrown when the Gemini API itself fails (transport, auth, quota). */
class GeminiApiError extends Error {}

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

function requireString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string") {
    throw new InvalidExtractionError(`job[${index}].${field} ausente ou não é string`);
  }
  return value;
}

function validateJob(value: unknown, index: number): ExtractedJob {
  if (!isRecord(value)) {
    throw new InvalidExtractionError(`job[${index}] não é um objeto`);
  }

  const id = requireString(value.id, "id", index);
  if (!/^\d+$/.test(id)) {
    throw new InvalidExtractionError(`job[${index}].id deve conter apenas dígitos`);
  }
  const title = requireString(value.title, "title", index);
  const company = requireString(value.company, "company", index);
  const location = requireString(value.location, "location", index);
  const publishedDate = requireString(value.publishedDate, "publishedDate", index);
  const description = requireString(value.description, "description", index);
  const url = requireString(value.url, "url", index);
  if (url.length === 0) {
    throw new InvalidExtractionError(`job[${index}].url está vazia`);
  }

  const workplaceType = requireString(value.workplaceType, "workplaceType", index);
  if (!isWorkplaceType(workplaceType)) {
    throw new InvalidExtractionError(`job[${index}].workplaceType inválido: ${workplaceType}`);
  }
  const jobType = requireString(value.jobType, "jobType", index);
  if (!isJobType(jobType)) {
    throw new InvalidExtractionError(`job[${index}].jobType inválido: ${jobType}`);
  }

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

function validateJobs(value: unknown): ExtractedJob[] {
  if (!Array.isArray(value)) {
    throw new InvalidExtractionError("a resposta não é um JSON array");
  }
  return value.map((item, index) => validateJob(item, index));
}

export class GeminiExtractor implements JobExtractor {
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly batchSize: number;
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
    this.logger = logger ?? noopLogger;
  }

  async extractJobs(htmlChunks: string[], sourceUrl: string): Promise<ExtractedJob[]> {
    const template = loadPromptTemplate();
    const jobs: ExtractedJob[] = [];
    const batches = chunkArray(htmlChunks, this.batchSize);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batchJobs = await this.extractBatch(
        batches[batchIndex],
        sourceUrl,
        template,
        batchIndex,
      );
      jobs.push(...batchJobs);
    }
    return jobs;
  }

  private async extractBatch(
    chunk: string[],
    sourceUrl: string,
    template: PromptTemplate,
    batchIndex: number,
  ): Promise<ExtractedJob[]> {
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
          latencyMs: Date.now() - startedAt,
          retryCount: attempt,
          success: false,
          error: errorMessage(err),
        });
        throw err;
      }

      try {
        const jobs = validateJobs(parseJobsJson(response.text));
        this.logger.info("gupy extraction batch succeeded", {
          batchIndex,
          cardsIn: chunk.length,
          jobsOut: jobs.length,
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
        return jobs;
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
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: this.maxOutputTokens },
      }),
    });
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
