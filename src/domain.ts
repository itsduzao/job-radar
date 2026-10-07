export interface Post {
  id: string;
  texto: string;
  url: string;
}

export type Tipo = "estagio" | "junior";
export type Modalidade = "remoto" | "hibrido" | "presencial";
export type Area = "backend" | "frontend" | "fullstack";

export interface Vaga {
  role: string;
  empresa: string;
  link: string;
  localizacao: string;
  tipo: Tipo;
  area: Area;
  modalidade: Modalidade;
}
