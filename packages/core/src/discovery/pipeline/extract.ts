import { getModels } from '../../db/models.js';
import { canonicalizeUrl, contentHash } from '../normalize.js';
import type { DiscoveryDeps } from './context.js';

export interface ExtractStats extends Record<string, unknown> {
  requested: number;
  extracted: number;
  extractionFailures: number;
  skippedOverCap: number;
}

/**
 * Extracts full text for this run's new articles, highest search score first, up to the cap.
 * A failed extraction keeps the search snippet as fallback evidence. Articles over the cap are
 * marked skipped and not processed further.
 */
export async function extractStage(runKey: string, deps: DiscoveryDeps): Promise<ExtractStats> {
  const { SourceArticle } = await getModels();
  const { config } = deps;
  const pending = await SourceArticle.find({ firstRunKey: runKey, extractionStatus: 'pending' })
    .sort({ searchScore: -1 })
    .lean();
  const selected = pending.slice(0, config.maxExtract);
  const overCap = pending.slice(config.maxExtract);
  if (overCap.length > 0) {
    await SourceArticle.updateMany(
      { _id: { $in: overCap.map((a) => a._id) } },
      { $set: { extractionStatus: 'skipped' } },
    );
  }
  if (selected.length === 0) {
    return { requested: 0, extracted: 0, extractionFailures: 0, skippedOverCap: overCap.length };
  }

  const { pages } = await deps.search.extract(
    selected.map((a) => a.url),
    { runKey },
  );
  const byCanonical = new Map(selected.map((a) => [a.canonicalUrl, a]));
  const now = deps.now();
  const done = new Set<string>();

  for (const page of pages) {
    const canonical = canonicalizeUrl(page.url);
    const article = canonical ? byCanonical.get(canonical) : undefined;
    if (!article || !page.content.trim()) continue;
    const content = page.content.slice(0, config.storedContentChars);
    await SourceArticle.updateOne(
      { _id: article._id },
      {
        $set: {
          content,
          contentHash: contentHash(content),
          extractionStatus: 'extracted',
          lastCheckedAt: now,
          ...(page.title && !article.originalHeadline ? { originalHeadline: page.title } : {}),
        },
      },
    );
    done.add(article.canonicalUrl);
  }

  const failed = selected.filter((a) => !done.has(a.canonicalUrl));
  for (const article of failed) {
    await SourceArticle.updateOne(
      { _id: article._id },
      { $set: { extractionStatus: 'failed', content: article.snippet, lastCheckedAt: now } },
    );
  }

  return {
    requested: selected.length,
    extracted: done.size,
    extractionFailures: failed.length,
    skippedOverCap: overCap.length,
  };
}
