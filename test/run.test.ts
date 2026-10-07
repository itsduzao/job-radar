import { describe, expect, it, vi } from "vitest";
import { collect, run } from "../src/run.js";
import type { Source } from "../src/source.js";

describe("collect", () => {
  it("coleta posts de todas as fontes", async () => {
    const a: Source = {
      fetchPosts: async () => [{ id: "1", texto: "a", url: "u1" }],
    };
    const b: Source = {
      fetchPosts: async () => [{ id: "2", texto: "b", url: "u2" }],
    };
    const posts = await collect([a, b]);
    expect(posts.map((p) => p.id)).toEqual(["1", "2"]);
  });
});

describe("run", () => {
  it("não envia digest enquanto não houver vagas (triagem pendente)", async () => {
    const sendMessage = vi.fn();
    const vagas = await run([], { sendMessage }, () => new Date("2026-10-07T12:00:00Z"));
    expect(vagas).toEqual([]);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
