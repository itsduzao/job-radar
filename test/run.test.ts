import { describe, expect, it } from "vitest";
import { run } from "../src/run.js";
import type { Source } from "../src/source.js";

describe("run", () => {
  it("coleta posts de todas as fontes", async () => {
    const a: Source = {
      fetchPosts: async () => [{ id: "1", texto: "a", url: "u1" }],
    };
    const b: Source = {
      fetchPosts: async () => [{ id: "2", texto: "b", url: "u2" }],
    };
    const posts = await run([a, b]);
    expect(posts.map((p) => p.id)).toEqual(["1", "2"]);
  });
});
