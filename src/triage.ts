import type { Modalidade, Post, Tipo, Vaga } from "./domain.js";

export type TriageResult =
  | { relevante: true; vaga: Omit<Vaga, "link"> }
  | { relevante: false; motivo: string };

export interface TriageProvider {
  triagePost(post: Post): Promise<TriageResult>;
}

const DEFAULT_MODEL = "gemini-2.0-flash";

export function buildPrompt(post: Post): string {
  return [
    "Você analisa posts do LinkedIn em busca de vagas de estágio e júnior em desenvolvimento de software.",
    "",
    "Critérios para a vaga ser RELEVANTE:",
    "- tipo: estágio ou júnior",
    "- área: desenvolvimento de software (backend, frontend, fullstack); excluir QA, DevOps, Mobile e dados",
    "- localização: São José/SC, Florianópolis/SC, ou remoto/home office",
    "- modalidade: remoto, híbrido ou presencial",
    "",
    "Responda APENAS com JSON, sem texto ao redor:",
    '- relevante: {"relevante":true,"vaga":{"role":"...","empresa":"...","localizacao":"...","tipo":"estagio|junior","area":"backend|frontend|fullstack","modalidade":"remoto|hibrido|presencial"}}',
    '- não relevante: {"relevante":false,"motivo":"curto motivo"}',
    "",
    "Post:",
    post.texto,
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTipo(value: unknown): Tipo | null {
  return value === "estagio" || value === "junior" ? value : null;
}

function parseModalidade(value: unknown): Modalidade | null {
  return value === "remoto" || value === "hibrido" || value === "presencial"
    ? value
    : null;
}

export function parseTriageResult(text: string): TriageResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { relevante: false, motivo: "resposta inválida do modelo" };
  }
  if (!isRecord(parsed)) {
    return { relevante: false, motivo: "resposta inválida do modelo" };
  }

  if (parsed.relevante === true) {
    const vaga = parsed.vaga;
    if (!isRecord(vaga)) {
      return { relevante: false, motivo: "vaga ausente" };
    }
    const tipo = parseTipo(vaga.tipo);
    const modalidade = parseModalidade(vaga.modalidade);
    if (
      typeof vaga.role !== "string" ||
      typeof vaga.empresa !== "string" ||
      typeof vaga.localizacao !== "string" ||
      typeof vaga.area !== "string" ||
      tipo === null ||
      modalidade === null
    ) {
      return { relevante: false, motivo: "campos da vaga inválidos" };
    }
    return {
      relevante: true,
      vaga: {
        role: vaga.role,
        empresa: vaga.empresa,
        localizacao: vaga.localizacao,
        tipo,
        area: vaga.area,
        modalidade,
      },
    };
  }

  if (parsed.relevante === false) {
    return {
      relevante: false,
      motivo: typeof parsed.motivo === "string" ? parsed.motivo : "sem motivo",
    };
  }

  return { relevante: false, motivo: "resposta inválida do modelo" };
}

export class GeminiTriageProvider implements TriageProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
  ) {}

  async triagePost(post: Post): Promise<TriageResult> {
    const prompt = buildPrompt(post);
    const text = await this.generate(prompt);
    return parseTriageResult(text);
  }

  private async generate(prompt: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) {
      throw new Error(`Gemini generateContent failed with status ${res.status}`);
    }
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error("Gemini response missing text");
    }
    return text;
  }
}

export interface TriageOutcome {
  vagas: Vaga[];
  descartados: { post: Post; motivo: string }[];
}

export async function triage(
  posts: Post[],
  provider: TriageProvider,
): Promise<TriageOutcome> {
  const vagas: Vaga[] = [];
  const descartados: { post: Post; motivo: string }[] = [];
  for (const post of posts) {
    const result = await provider.triagePost(post);
    if (result.relevante) {
      vagas.push({ ...result.vaga, link: post.url });
    } else {
      descartados.push({ post, motivo: result.motivo });
    }
  }
  return { vagas, descartados };
}
