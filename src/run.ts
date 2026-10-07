import { dedupe } from "./dedupe.js";
import type { Post, Vaga } from "./domain.js";
import type { SeenStore } from "./seen.js";
import type { Source } from "./source.js";
import { sendDigest, type TelegramClient } from "./telegram.js";

export async function collect(sources: Source[]): Promise<Post[]> {
  const posts: Post[] = [];
  for (const source of sources) {
    posts.push(...(await source.fetchPosts()));
  }
  return posts;
}

export async function run(
  sources: Source[],
  telegram: TelegramClient,
  seen: SeenStore,
  now: () => Date = () => new Date(),
): Promise<Vaga[]> {
  const posts = await collect(sources);
  console.log(`[job-radar] collected ${posts.length} candidate post(s)`);

  const seenIds = await seen.load();
  const { novos, vistosAgora } = dedupe(posts, seenIds);
  console.log(`[job-radar] ${novos.length} new post(s) after dedupe`);

  // Triagem (ticket 05) converte posts em vagas; ainda não implementada.
  const vagas: Vaga[] = [];
  await sendDigest(vagas, telegram, now());

  if (vistosAgora.length > 0) {
    await seen.save(new Set([...seenIds, ...vistosAgora]));
  }
  return vagas;
}
