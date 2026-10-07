import type { Post } from "./domain.js";
import type { Source } from "./source.js";

export async function run(sources: Source[]): Promise<Post[]> {
  const posts: Post[] = [];
  for (const source of sources) {
    posts.push(...(await source.fetchPosts()));
  }
  console.log(`[job-radar] collected ${posts.length} candidate post(s)`);
  return posts;
}
