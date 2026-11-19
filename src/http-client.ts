export class HttpError extends Error {
  public readonly status: number;
  public readonly retryAfter: number | null;
  public readonly isRetryable: boolean;
  public readonly isTimeout: boolean;

  constructor(
    message: string,
    options: {
      status: number;
      retryAfter?: number | null;
      isRetryable?: boolean;
      isTimeout?: boolean;
    }
  ) {
    super(message);
    this.name = "HttpError";
    this.status = options.status;
    this.retryAfter = options.retryAfter ?? null;
    this.isRetryable = options.isRetryable ?? false;
    this.isTimeout = options.isTimeout ?? false;
  }
}

interface HttpClientOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  respectRetryAfter?: boolean;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_TIMEOUT_MS = 15000;

export class HttpClient {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly respectRetryAfter: boolean;

  constructor(options: HttpClientOptions = {}) {
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.respectRetryAfter = options.respectRetryAfter ?? true;
  }

  async get(url: string, headers?: Record<string, string>): Promise<Response> {
    let attempt = 0;
    let lastError: Error | null = null;

    const isGupyApi = url.includes("portal-api.gupy.io") || url.includes("api.gupy.io") || url.includes("portal.gupy.io/api");
    const isGupyPortalApi = url.includes("api.gupy.io");
    const isGupyPortalSearch = url.includes("portal.gupy.io/job-search") || url.includes("portal.gupy.io/job/");
    const defaultHeaders: Record<string, string> = {
      "accept": "application/json",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ...((isGupyApi || isGupyPortalApi || isGupyPortalSearch) ? {
        "referer": "https://portal.gupy.io/",
        "origin": "https://portal.gupy.io",
      } : {}),
      ...headers,
    };

    while (attempt <= this.maxRetries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        const response = await fetch(url, {
          method: "GET",
          headers: defaultHeaders,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          return response;
        }

        const retryAfter = this.respectRetryAfter
          ? this.parseRetryAfter(response.headers.get("retry-after"))
          : null;

        const isRetryable = this.isRetryableStatus(response.status);

        if (isRetryable && attempt < this.maxRetries) {
          const delay = this.calculateDelay(attempt, retryAfter);
          await this.sleep(delay);
          attempt++;
          continue;
        }

        const errorMessage = await this.extractErrorMessage(response);
        throw new HttpError(errorMessage, {
          status: response.status,
          retryAfter,
          isRetryable,
          isTimeout: false,
        });
      } catch (error) {
        lastError = error as Error;

        if (error instanceof HttpError) {
          throw error;
        }

        const isTimeout =
          error instanceof Error &&
          (error.name === "AbortError" || error.message === "Aborted");

        if (isTimeout) {
          throw new HttpError("Request timeout", {
            status: 0,
            retryAfter: null,
            isRetryable: attempt < this.maxRetries,
            isTimeout: true,
          });
        }

        const isNetworkError =
          error instanceof TypeError ||
          (error instanceof Error && error.message.includes("network"));
        if (isNetworkError && attempt < this.maxRetries) {
          const delay = this.calculateDelay(attempt, null);
          await this.sleep(delay);
          attempt++;
          continue;
        }

        throw error;
      }
    }

    throw lastError;
  }

  private isRetryableStatus(status: number): boolean {
    return status === 429 || (status >= 500 && status < 600);
  }

  private parseRetryAfter(header: string | null): number | null {
    if (!header) return null;
    const seconds = parseInt(header, 10);
    return isNaN(seconds) ? null : seconds;
  }

  private calculateDelay(attempt: number, retryAfter: number | null): number {
    if (retryAfter !== null && retryAfter > 0) {
      return Math.min(retryAfter * 1000, this.maxDelayMs);
    }
    const exponentialDelay = this.baseDelayMs * Math.pow(2, attempt);
    const jitter = Math.random() * 0.3 * exponentialDelay;
    return Math.min(exponentialDelay + jitter, this.maxDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async extractErrorMessage(response: Response): Promise<string> {
    try {
      const data = (await response.json()) as Record<string, unknown>;
      return (data.message as string) || (data.error as string) || `HTTP ${response.status}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  }
}

export function createGupyHttpClient(): HttpClient {
  const maxRetries = parseInt(process.env.GUPY_MAX_RETRIES ?? "", 10) || 3;
  const baseDelayMs = parseInt(process.env.GUPY_BASE_DELAY_MS ?? "", 10) || 1000;
  const timeoutMs = parseInt(process.env.GUPY_TIMEOUT_MS ?? "", 10) || 15000;

  return new HttpClient({
    maxRetries,
    baseDelayMs,
    timeoutMs,
  });
}