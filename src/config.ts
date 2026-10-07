export type SourceId = "linkedin";
export type SortBy = "date_posted";

export interface Query {
  source: SourceId;
  keywords: string;
  sortBy: SortBy;
}

export interface Secrets {
  liCookie?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  geminiApiKey?: string;
}

export interface Config {
  queries: Query[];
  secrets: Secrets;
}

const QUERIES: Query[] = [
  {
    source: "linkedin",
    sortBy: "date_posted",
    keywords:
      'vaga (estagio OR junior OR jr) (desenvolvedor OR ti OR tecnologia) (florianopolis OR florianópolis OR "sao jose" OR "são josé" OR remoto OR "home office") NOT Netvagas',
  },
];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    queries: QUERIES,
    secrets: {
      liCookie: env.LI_COOKIE,
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      telegramChatId: env.TELEGRAM_CHAT_ID,
      geminiApiKey: env.GEMINI_API_KEY,
    },
  };
}
