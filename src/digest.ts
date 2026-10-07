import type { Vaga } from "./domain.js";

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function vagasLabel(count: number): string {
  return count === 1 ? "1 vaga nova" : `${count} vagas novas`;
}

export function formatDigest(vagas: Vaga[], runDate: Date): string {
  const header = `${vagasLabel(vagas.length)} (run de ${formatDate(runDate)})`;
  const lines = vagas.map((v) => `${v.role} · ${v.empresa} · ${v.localizacao} · ${v.link}`);
  return [header, ...lines].join("\n");
}
