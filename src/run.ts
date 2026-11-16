import { dedupe } from "./dedupe.js";
import type { Post, Vaga } from "./domain.js";
import type { SeenStore } from "./seen.js";
import type { Source } from "./source.js";
import { sendDigest, type TelegramClient } from "./telegram.js";
import { triage, type TriageProvider } from "./triage.js";
import { createLogger } from "./logger.js";

const logger = createLogger("run");

export interface RunDeps {
  sources: Source[];
  telegram: TelegramClient;
  seen: SeenStore;
  triageProvider: TriageProvider;
  now?: () => Date;
}

export async function collect(sources: Source[]): Promise<Post[]> {
  const results = await Promise.allSettled(
    sources.map((source) => source.fetchPosts())
  );
  const posts: Post[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      posts.push(...result.value);
    } else {
      logger.error("Source fetch failed", { error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    }
  }
  return posts;
}

export async function run(deps: RunDeps): Promise<Vaga[]> {
  const now = deps.now ?? (() => new Date());
  const posts = await collect(deps.sources);
  logger.info("Collection completed", { collected: posts.length });

  const seenIds = await deps.seen.load();
  const novos = dedupe(posts, seenIds);
  logger.info("Dedupe completed", { newPosts: novos.length });

  const { vagas, descartados } = await triage(novos, deps.triageProvider);
  for (const descartado of descartados) {
    logger.info("Post discarded", { postId: descartado.post.id, motivo: descartado.motivo });
  }

  await sendDigest(vagas, deps.telegram, now());

  if (novos.length > 0) {
    await deps.seen.save(new Set([...seenIds, ...novos.map((p) => p.id)]));
  }
  return vagas;
}
