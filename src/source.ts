import type { Post } from "./domain.js";

export interface Source {
  fetchPosts(): Promise<Post[]>;
}

export class StubSource implements Source {
  async fetchPosts(): Promise<Post[]> {
    return [
      {
        id: "urn:li:activity:1234567890",
        texto:
          "Estamos contratando estagiário de desenvolvimento backend em Florianópolis!",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:1234567890",
      },
    ];
  }
}
