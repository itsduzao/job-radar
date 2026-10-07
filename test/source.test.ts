import { describe, expect, it } from "vitest";
import { StubSource } from "../src/source.js";

describe("StubSource", () => {
  it("devolve ao menos um post com id, texto e url", async () => {
    const posts = await new StubSource().fetchPosts();
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(typeof post.id).toBe("string");
      expect(post.id.length).toBeGreaterThan(0);
      expect(typeof post.texto).toBe("string");
      expect(post.texto.length).toBeGreaterThan(0);
      expect(typeof post.url).toBe("string");
      expect(post.url.length).toBeGreaterThan(0);
    }
  });
});
