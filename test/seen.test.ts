import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSeenStore } from "../src/seen.js";

describe("FileSeenStore", () => {
  it("faz roundtrip de ids num arquivo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seen-"));
    try {
      const store = new FileSeenStore(join(dir, "seen.json"));
      await store.save(new Set(["urn:2", "urn:1"]));
      expect(await store.load()).toEqual(new Set(["urn:1", "urn:2"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("devolve vazio quando o arquivo não existe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seen-"));
    try {
      const store = new FileSeenStore(join(dir, "nao-existe.json"));
      expect(await store.load()).toEqual(new Set());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
