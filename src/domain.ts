export interface Post {
  id: string;
  texto: string;
  url: string;
}

export type Tipo = "estagio" | "junior";
export type Modalidade = "remoto" | "hibrido" | "presencial";

export interface Vaga {
  role: string;
  empresa: string;
  link: string;
  localizacao: string;
  tipo: Tipo;
  area: string;
  modalidade: Modalidade;
}
