import type { Post } from "./domain.js";

export function dedupe(posts: Post[], seenIds: Set<string>): Post[] {
  return posts.filter((post) => !seenIds.has(post.id));
}
