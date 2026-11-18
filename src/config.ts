export type SourceId = "linkedin" | "gupy";
export type SortBy = "date_posted";

export interface LinkedInQuery {
  source: "linkedin";
  keywords: string;
  sortBy: SortBy;
}

export interface GupySearchProfile {
  name: string;
  state?: string;
  cities?: string[];
  workplaceTypes?: string[];
  jobTypes?: string[];
}

export interface GupySearchConfig {
  source: "gupy";
  profiles: GupySearchProfile[];
  terms: string[];
}

export type Query = LinkedInQuery | GupySearchConfig;

export interface Secrets {
  liCookie?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  geminiApiKey?: string;
}

export interface GupyLlmConfig {
  enabled: boolean;
  model: string;
  maxOutputTokens: number;
  batchSize: number;
}

export interface Config {
  queries: Query[];
  secrets: Secrets;
  gupyLlm: GupyLlmConfig;
}

const DEFAULT_GEMINI_EXTRACTION_MODEL = "gemini-1.5-flash";
const DEFAULT_GEMINI_EXTRACTION_MAX_TOKENS = 8000;
const DEFAULT_GEMINI_EXTRACTION_BATCH_SIZE = 10;

const DEFAULT_GUPY_PROFILES: GupySearchProfile[] = [
  {
    name: "florianopolis-sc",
    state: "SC",
    cities: ["Florianópolis", "São José", "Palhoça", "Biguaçu", "Santo Amaro da Imperatriz"],
    workplaceTypes: ["remote", "hybrid", "onSite"],
    jobTypes: ["vacancy_type_internship", "vacancy_type_trainee", "vacancy_type_effective"],
  },
  {
    name: "remote-br",
    workplaceTypes: ["remote"],
    jobTypes: ["vacancy_type_internship", "vacancy_type_trainee", "vacancy_type_effective"],
  },
];

const DEFAULT_GUPY_TERMS = [
  "estagio",
  "estagiaria",
  "estágio",
  "estagiária",
  "jr",
  "junior",
  "júnior",
  "desenvolvedor",
  "dev",
  "backend",
  "frontend",
  "fullstack",
  "full stack",
];

const QUERIES: LinkedInQuery[] = [
  {
    source: "linkedin",
    sortBy: "date_posted",
    keywords: "vaga (estagio OR junior OR jr) desenvolvedor NOT Netvagas NOT DEVagas",
  },
];

function buildGupyQueries(env: NodeJS.ProcessEnv): GupySearchConfig[] {
  const enableGupy = env.ENABLE_GUPY_SOURCE === "true";
  if (!enableGupy) {
    return [];
  }

  const profiles = DEFAULT_GUPY_PROFILES;
  const terms = DEFAULT_GUPY_TERMS;

  if (profiles.length === 0) {
    throw new Error("Gupy source enabled but no profiles configured");
  }
  if (terms.length === 0) {
    throw new Error("Gupy source enabled but no search terms configured");
  }

  return [
    {
      source: "gupy",
      profiles,
      terms,
    },
  ];
}

function positiveIntFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildGupyLlmConfig(env: NodeJS.ProcessEnv): GupyLlmConfig {
  const enabled = env.GUPY_USE_LLM_EXTRACTION === "true";
  const apiKey = env.GEMINI_API_KEY?.trim();

  if (enabled && !apiKey) {
    throw new Error(
      "GUPY_USE_LLM_EXTRACTION=true exige GEMINI_API_KEY definido (extração via Gemini)",
    );
  }

  return {
    enabled,
    model: env.GEMINI_EXTRACTION_MODEL?.trim() || DEFAULT_GEMINI_EXTRACTION_MODEL,
    maxOutputTokens: positiveIntFromEnv(
      env,
      "GEMINI_EXTRACTION_MAX_TOKENS",
      DEFAULT_GEMINI_EXTRACTION_MAX_TOKENS,
    ),
    batchSize: positiveIntFromEnv(
      env,
      "GEMINI_EXTRACTION_BATCH_SIZE",
      DEFAULT_GEMINI_EXTRACTION_BATCH_SIZE,
    ),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const gupyQueries = buildGupyQueries(env);
  const allQueries: Query[] = [...QUERIES, ...gupyQueries];
  const gupyLlm = buildGupyLlmConfig(env);

  if (gupyQueries.length > 0 && !env.LI_COOKIE) {
    console.warn("[job-radar] LI_COOKIE ausente; LinkedIn source será desativado");
  }

  return {
    queries: allQueries,
    secrets: {
      liCookie: env.LI_COOKIE,
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      telegramChatId: env.TELEGRAM_CHAT_ID,
      geminiApiKey: env.GEMINI_API_KEY,
    },
    gupyLlm,
  };
}

export { DEFAULT_GUPY_PROFILES, DEFAULT_GUPY_TERMS };