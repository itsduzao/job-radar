import { describe, expect, it, vi } from "vitest";
import { collect, run } from "../src/run.js";
import type { SeenStore } from "../src/seen.js";
import type { Source } from "../src/source.js";
import type { TriageProvider } from "../src/triage.js";
import type { Post } from "../src/domain.js";

function inMemoryStore(initial: string[] = []) {
  const ids = new Set(initial);
  const store: SeenStore = {
    async load() {
      return new Set(ids);
    },
    async save(next: Set<string>) {
      ids.clear();
      for (const id of next) ids.add(id);
    },
  };
  return { store, ids };
}

describe("run integration with Gupy and LinkedIn sources", () => {
  it("collects from multiple sources in parallel with Promise.allSettled", async () => {
    const linkedInSource: Source = {
      fetchPosts: async () => [
        { id: "urn:li:1", texto: "LinkedIn vaga", url: "https://linkedin.com/1" },
      ],
    };
    const gupySource: Source = {
      fetchPosts: async () => [
        { id: "gupy:123", texto: "Gupy vaga", url: "https://portal.gupy.io/job/123" },
      ],
    };

    const posts = await collect([linkedInSource, gupySource]);
    expect(posts.map((p) => p.id)).toEqual(["urn:li:1", "gupy:123"]);
  });

  it("handles source failure gracefully with allSettled", async () => {
    const failingSource: Source = {
      fetchPosts: async () => {
        throw new Error("Network error");
      },
    };
    const workingSource: Source = {
      fetchPosts: async () => [{ id: "gupy:123", texto: "Gupy vaga", url: "https://portal.gupy.io/job/123" }],
    };

    const posts = await collect([failingSource, workingSource]);
    expect(posts.map((p) => p.id)).toEqual(["gupy:123"]);
  });

  it("run with both LinkedIn and Gupy sources produces combined digest", async () => {
    const sendMessage = vi.fn();
    const { store } = inMemoryStore();

    const linkedInSource: Source = {
      fetchPosts: async () => [{ id: "urn:li:1", texto: "Estágio Backend LinkedIn", url: "https://linkedin.com/1" }],
    };
    const gupySource: Source = {
      fetchPosts: async () => [{ id: "gupy:123", texto: "Estágio Frontend Gupy", url: "https://portal.gupy.io/job/123" }],
    };

    const provider: TriageProvider = {
      async triagePost(p) {
        return {
          relevante: true,
          vaga: {
            role: p.texto.includes("Backend") ? "Estágio Backend" : "Estágio Frontend",
            empresa: "TestCorp",
            localizacao: "Florianópolis/SC",
            tipo: "estagio",
            area: "backend",
            modalidade: "remoto",
          },
        };
      },
    };

    await run({
      sources: [linkedInSource, gupySource],
      telegram: { sendMessage },
      seen: store,
      triageProvider: provider,
      now: () => new Date("2026-10-07T12:00:00Z"),
    });

    expect(sendMessage).toHaveBeenCalled();
    const callArgs = sendMessage.mock.calls[0][0];
    expect(callArgs).toContain("Estágio Backend");
    expect(callArgs).toContain("Estágio Frontend");
  });

  it("namespaced IDs prevent cross-source dedupe collision", async () => {
    const { store } = inMemoryStore(["urn:li:1"]);

    const linkedInSource: Source = {
      fetchPosts: async () => [{ id: "urn:li:1", texto: "LinkedIn vaga", url: "https://linkedin.com/1" }],
    };
    const gupySource: Source = {
      fetchPosts: async () => [{ id: "gupy:1", texto: "Gupy vaga", url: "https://portal.gupy.io/job/1" }],
    };

    const provider: TriageProvider = {
      async triagePost() {
        return { relevante: false, motivo: "test" };
      },
    };

    await run({
      sources: [linkedInSource, gupySource],
      telegram: { sendMessage: vi.fn() },
      seen: store,
      triageProvider: provider,
      now: () => new Date("2026-10-07T12:00:00Z"),
    });

    // Both IDs should be tracked separately in seen store
    const seenIds = await store.load();
    expect(seenIds.has("urn:li:1")).toBe(true);
    expect(seenIds.has("gupy:1")).toBe(true);
  });
});