import { describe, expect, it, vi } from "vitest";
import {
  buildPrompt,
  GeminiTriageProvider,
  parseTriageResult,
  triage,
} from "../src/triage.js";
import type { TriageProvider } from "../src/triage.js";
import type { Post } from "../src/domain.js";

const post: Post = {
  id: "urn:1",
  texto: "Estamos contratando estagiário backend em Florianópolis!",
  url: "https://example.com/post/1",
};

describe("buildPrompt", () => {
  it("inclui os critérios e o texto do post", () => {
    const prompt = buildPrompt(post);
    expect(prompt).toContain("estágio");
    expect(prompt).toContain("júnior");
    expect(prompt).toContain("QA");
    expect(prompt).toContain("DevOps");
    expect(prompt).toContain("Mobile");
    expect(prompt).toContain("dados");
    expect(prompt).toContain("Florianópolis");
    expect(prompt).toContain("remoto");
    expect(prompt).toContain(post.texto);
  });
});

describe("parseTriageResult", () => {
  it("parseia uma vaga relevante", () => {
    const result = parseTriageResult(
      JSON.stringify({
        relevante: true,
        vaga: {
          role: "Estágio Backend",
          empresa: "Acme",
          localizacao: "Florianópolis/SC",
          tipo: "estagio",
          area: "backend",
          modalidade: "remoto",
        },
      }),
    );
    expect(result).toEqual({
      relevante: true,
      vaga: {
        role: "Estágio Backend",
        empresa: "Acme",
        localizacao: "Florianópolis/SC",
        tipo: "estagio",
        area: "backend",
        modalidade: "remoto",
      },
    });
  });

  it("parseia um post irrelevante com motivo", () => {
    const result = parseTriageResult(
      JSON.stringify({ relevante: false, motivo: "vaga pleno" }),
    );
    expect(result).toEqual({ relevante: false, motivo: "vaga pleno" });
  });

  it("descarta JSON inválido", () => {
    const result = parseTriageResult("não é json");
    expect(result).toEqual({ relevante: false, motivo: "resposta inválida do modelo" });
  });

  it("descarta vaga com tipo ou modalidade inválidos", () => {
    const result = parseTriageResult(
      JSON.stringify({
        relevante: true,
        vaga: {
          role: "x",
          empresa: "y",
          localizacao: "z",
          tipo: "senior",
          area: "backend",
          modalidade: "remoto",
        },
      }),
    );
    expect(result).toEqual({ relevante: false, motivo: "campos da vaga inválidos" });
  });

  it("descarta vaga com área fora do permitido", () => {
    const result = parseTriageResult(
      JSON.stringify({
        relevante: true,
        vaga: {
          role: "x",
          empresa: "y",
          localizacao: "z",
          tipo: "estagio",
          area: "dados",
          modalidade: "remoto",
        },
      }),
    );
    expect(result).toEqual({ relevante: false, motivo: "campos da vaga inválidos" });
  });
});

describe("triage", () => {
  it("constrói vaga com link e separa descartados", async () => {
    const provider: TriageProvider = {
      async triagePost(p) {
        if (p.id === "urn:rel") {
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
        }
        return { relevante: false, motivo: "não é vaga" };
      },
    };
    const rel: Post = { id: "urn:rel", texto: "a", url: "https://example.com/rel" };
    const irrel: Post = { id: "urn:irrel", texto: "b", url: "https://example.com/irrel" };
    const { vagas, descartados } = await triage([rel, irrel], provider);

    expect(vagas).toEqual([
      {
        role: "Estágio Backend",
        empresa: "Acme",
        localizacao: "Florianópolis/SC",
        tipo: "estagio",
        area: "backend",
        modalidade: "remoto",
        link: "https://example.com/rel",
      },
    ]);
    expect(descartados).toEqual([{ post: irrel, motivo: "não é vaga" }]);
  });

  it("descarta com motivo quando o provider lança erro", async () => {
    const provider: TriageProvider = {
      async triagePost() {
        throw new Error("boom");
      },
    };
    const { vagas, descartados } = await triage([post], provider);
    expect(vagas).toEqual([]);
    expect(descartados).toEqual([{ post, motivo: "erro na triagem: boom" }]);
  });
});

describe("GeminiTriageProvider", () => {
  it("chama a API do Gemini e parseia a resposta", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    relevante: true,
                    vaga: {
                      role: "Estágio Backend",
                      empresa: "Acme",
                      localizacao: "Florianópolis/SC",
                      tipo: "estagio",
                      area: "backend",
                      modalidade: "remoto",
                    },
                  }),
                },
              ],
            },
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const provider = new GeminiTriageProvider("chave");
      const result = await provider.triagePost(post);

      expect(result.relevante).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=chave",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
      const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(body.contents[0].parts[0].text).toContain(post.texto);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("lança erro quando a API responde com falha", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    try {
      const provider = new GeminiTriageProvider("chave");
      await expect(provider.triagePost(post)).rejects.toThrow("403");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
