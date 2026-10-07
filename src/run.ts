import { dedupe } from "./dedupe.js";
import type { Post, Vaga } from "./domain.js";
import type { SeenStore } from "./seen.js";
import type { Source } from "./source.js";
import { sendDigest, type TelegramClient } from "./telegram.js";
import { triage, type TriageProvider } from "./triage.js";

export interface RunDeps {
  sources: Source[];
  telegram: TelegramClient;
  seen: SeenStore;
  triageProvider: TriageProvider;
  now?: () => Date;
}

export async function collect(sources: Source[]): Promise<Post[]> {
  const posts: Post[] = [];
  for (const source of sources) {
    posts.push(...(await source.fetchPosts()));
  }
  return posts;
}

export async function run(deps: RunDeps): Promise<Vaga[]> {
  const now = deps.now ?? (() => new Date());
  const posts = await collect(deps.sources);
  console.log(`[job-radar] collected ${posts.length} candidate post(s)`);

  const seenIds = await deps.seen.load();
  const novos = dedupe(posts, seenIds);
  console.log(`[job-radar] ${novos.length} new post(s) after dedupe`);

  const { vagas, descartados } = await triage(novos, deps.triageProvider);
  for (const descartado of descartados) {
    console.log(`[job-radar] discarded ${descartado.post.id}: ${descartado.motivo}`);
  }

  await sendDigest(vagas, deps.telegram, now());

  if (novos.length > 0) {
    await deps.seen.save(new Set([...seenIds, ...novos.map((p) => p.id)]));
  }
  return vagas;
}
