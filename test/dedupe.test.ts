import { describe, expect, it } from "vitest";
import { dedupe } from "../src/dedupe.js";
import type { Post } from "../src/domain.js";

const p1: Post = { id: "urn:1", texto: "a", url: "u1" };
const p2: Post = { id: "urn:2", texto: "b", url: "u2" };

describe("dedupe", () => {
  it("devolve apenas posts novos e seus ids", () => {
    const { novos, vistosAgora } = dedupe([p1, p2], new Set(["urn:1"]));
    expect(novos).toEqual([p2]);
    expect(vistosAgora).toEqual(["urn:2"]);
  });

  it("devolve nada quando todos já foram vistos", () => {
    const { novos, vistosAgora } = dedupe([p1, p2], new Set(["urn:1", "urn:2"]));
    expect(novos).toEqual([]);
    expect(vistosAgora).toEqual([]);
  });
});
