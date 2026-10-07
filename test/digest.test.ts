import { describe, expect, it } from "vitest";
import { formatDigest } from "../src/digest.js";
import { runDate, vaga } from "./fixtures.js";

describe("formatDigest", () => {
  it("formata o cabeçalho e uma linha por vaga", () => {
    const text = formatDigest([vaga], runDate);
    expect(text).toBe(
      "1 vaga nova (run de 2026-10-07)\n" +
        "Estágio em Desenvolvimento Backend · Acme · Florianópolis/SC · https://example.com/post/1",
    );
  });

  it("pluraliza o cabeçalho com mais de uma vaga", () => {
    const text = formatDigest([vaga, { ...vaga, role: "Júnior Frontend" }], runDate);
    expect(text.split("\n")[0]).toBe("2 vagas novas (run de 2026-10-07)");
  });
});
