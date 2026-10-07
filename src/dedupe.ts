import type { Post } from "./domain.js";

export interface DedupeResult {
  novos: Post[];
  vistosAgora: string[];
}

export function dedupe(posts: Post[], seenIds: Set<string>): DedupeResult {
  const novos: Post[] = [];
  const vistosAgora: string[] = [];
  for (const post of posts) {
    if (seenIds.has(post.id)) {
      continue;
    }
    novos.push(post);
    vistosAgora.push(post.id);
  }
  return { novos, vistosAgora };
}
