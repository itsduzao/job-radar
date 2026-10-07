import { describe, expect, it, vi } from "vitest";
import { collect, run } from "../src/run.js";
import type { SeenStore } from "../src/seen.js";
import type { Source } from "../src/source.js";
import type { TriageProvider } from "../src/triage.js";

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

const onePostSource = (): Source => ({
  fetchPosts: async () => [{ id: "urn:1", texto: "a", url: "u1" }],
});

const discardingTriage: TriageProvider = {
  async triagePost() {
    return { relevante: false, motivo: "teste" };
  },
};

describe("collect", () => {
  it("coleta posts de todas as fontes", async () => {
    const a: Source = { fetchPosts: async () => [{ id: "1", texto: "a", url: "u1" }] };
    const b: Source = { fetchPosts: async () => [{ id: "2", texto: "b", url: "u2" }] };
    const posts = await collect([a, b]);
    expect(posts.map((p) => p.id)).toEqual(["1", "2"]);
  });
});

describe("run", () => {
  it("marca como vistos os posts novos no primeiro run", async () => {
    const { store, ids } = inMemoryStore();
    await run({
      sources: [onePostSource()],
      telegram: { sendMessage: vi.fn() },
      seen: store,
      triageProvider: discardingTriage,
      now: () => new Date("2026-10-07T12:00:00Z"),
    });
    expect(ids).toEqual(new Set(["urn:1"]));
  });

  it("não envia nada para um post já visto", async () => {
    const sendMessage = vi.fn();
    const { store, ids } = inMemoryStore(["urn:1"]);
    await run({
      sources: [onePostSource()],
      telegram: { sendMessage },
      seen: store,
      triageProvider: discardingTriage,
      now: () => new Date("2026-10-07T12:00:00Z"),
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ids).toEqual(new Set(["urn:1"]));
  });

  it("envia digest com as vagas relevantes", async () => {
    const sendMessage = vi.fn();
    const { store } = inMemoryStore();
    const provider: TriageProvider = {
      async triagePost() {
        return {
          relevante: true,
          vaga: {
            role: "Estágio Backend",
            empresa: "Acme",
            localizacao: "Florianópolis/SC",
            tipo: "estagio",
            area: "backend",
            modalidade: "remoto",
          },
        };
      },
    };
    await run({
      sources: [onePostSource()],
      telegram: { sendMessage },
      seen: store,
      triageProvider: provider,
      now: () => new Date("2026-10-07T12:00:00Z"),
    });
    expect(sendMessage).toHaveBeenCalled();
  });
});
