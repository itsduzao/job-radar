import { describe, expect, it } from "vitest";
import { run } from "../src/run.js";

describe("run", () => {
  it("completes without throwing", async () => {
    await expect(run()).resolves.toBeUndefined();
  });
});
