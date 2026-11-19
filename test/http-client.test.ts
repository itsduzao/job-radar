import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { HttpClient, HttpError } from "../src/http-client.js";

describe("HttpClient", () => {
  let originalFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  function mockResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  describe("success", () => {
    it("returns Response on 200", async () => {
      fetchMock.mockResolvedValue(mockResponse(200, { data: "ok" }));
      const client = new HttpClient();
      const response = await client.get("https://api.example.com/test");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: "ok" });
    });
  });

  describe("retry on 429 with Retry-After header", () => {
    it("waits for Retry-After seconds then retries and succeeds", async () => {
      fetchMock
        .mockResolvedValueOnce(
          mockResponse(429, { error: "rate limited" }, { "retry-after": "1" })
        )
        .mockResolvedValueOnce(mockResponse(200, { data: "ok" }));

      const client = new HttpClient({ maxRetries: 3, baseDelayMs: 10 });
      const response = await client.get("https://api.example.com/test");
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("uses exponential backoff when Retry-After header is missing", async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(429, { error: "rate limited" }))
        .mockResolvedValueOnce(mockResponse(429, { error: "rate limited" }))
        .mockResolvedValueOnce(mockResponse(200, { data: "ok" }));

      const client = new HttpClient({ maxRetries: 3, baseDelayMs: 10 });
      const response = await client.get("https://api.example.com/test");
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("retry on 5xx", () => {
    it("retries on 500 with exponential backoff", async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(500, { error: "server error" }))
        .mockResolvedValueOnce(mockResponse(200, { data: "ok" }));

      const client = new HttpClient({ maxRetries: 3, baseDelayMs: 10 });
      const response = await client.get("https://api.example.com/test");
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("retries on 502", async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(502, { error: "bad gateway" }))
        .mockResolvedValueOnce(mockResponse(200, { data: "ok" }));

      const client = new HttpClient({ maxRetries: 3, baseDelayMs: 10 });
      const response = await client.get("https://api.example.com/test");
      expect(response.status).toBe(200);
    });

    it("retries on 503", async () => {
      fetchMock
        .mockResolvedValueOnce(mockResponse(503, { error: "service unavailable" }))
        .mockResolvedValueOnce(mockResponse(200, { data: "ok" }));

      const client = new HttpClient({ maxRetries: 3, baseDelayMs: 10 });
      const response = await client.get("https://api.example.com/test");
      expect(response.status).toBe(200);
    });
  });

  describe("no retry on 403", () => {
    it("throws HttpError with isRetryable=false on 403", async () => {
      fetchMock.mockResolvedValue(mockResponse(403, { error: "forbidden" }));

      const client = new HttpClient({ maxRetries: 3, baseDelayMs: 10 });
      try {
        await client.get("https://api.example.com/test");
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).status).toBe(403);
        expect((e as HttpError).isRetryable).toBe(false);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("timeout", () => {
    it("throws HttpError with isTimeout=true on AbortSignal timeout", async () => {
      fetchMock.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("Aborted")), 100);
          })
      );

      const client = new HttpClient({ timeoutMs: 50 });
      await expect(client.get("https://api.example.com/test")).rejects.toThrow(
        HttpError
      );
      try {
        await client.get("https://api.example.com/test");
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).isTimeout).toBe(true);
      }
    });
  });

  describe("network error", () => {
    it("retries on network error with exponential backoff", async () => {
      fetchMock
        .mockRejectedValueOnce(new Error("network error"))
        .mockResolvedValueOnce(mockResponse(200, { data: "ok" }));

      const client = new HttpClient({ maxRetries: 3, baseDelayMs: 10 });
      const response = await client.get("https://api.example.com/test");
      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("maxRetries=0", () => {
    it("does not retry when maxRetries=0", async () => {
      fetchMock.mockResolvedValue(mockResponse(500, { error: "server error" }));

      const client = new HttpClient({ maxRetries: 0 });
      await expect(client.get("https://api.example.com/test")).rejects.toThrow(
        HttpError
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe("HttpError", () => {
    it("contains status, retryAfter, isRetryable, isTimeout", async () => {
      fetchMock.mockResolvedValue(
        mockResponse(429, { error: "rate limited" }, { "retry-after": "5" })
      );

      const client = new HttpClient({ maxRetries: 0 });
      try {
        await client.get("https://api.example.com/test");
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError);
        expect((e as HttpError).status).toBe(429);
        expect((e as HttpError).retryAfter).toBe(5);
        expect((e as HttpError).isRetryable).toBe(true);
        expect((e as HttpError).isTimeout).toBe(false);
      }
    });
  });
});