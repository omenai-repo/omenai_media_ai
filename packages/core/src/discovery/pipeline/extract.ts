import { getModels } from '../../db/models.js';
import { pickPreviewImage } from '../images.js';
import { articleIntake, fairOrder } from '../intake.js';
import { canonicalizeUrl, contentHash } from '../normalize.js';
import type { DiscoveryDeps } from './context.js';

export interface ExtractStats extends Record<string, unknown> {
  requested: number;
  extracted: number;
  extractionFailures: number;
  /** Over the cap: still pending, taken first by a later run (ADR-042). */
  waiting: number;
  /** Aged past the freshness window while waiting; counted, never silently dropped. */
  expired: number;
  /** Taken from earlier runs' backlog. */
  fromBacklog: number;
}

const DAY_MS = 86_400_000;

/**
 * Extracts full text for up to `maxExtract` waiting articles: older runs' backlog first, then the
 * queries taking turns, each in its own search-score order. Articles over the cap stay pending
 * for a later run, until they age past the freshness window, when they are marked expired. A
 * failed extraction keeps the search snippet as fallback evidence.
 */
export async function extractStage(runKey: string, deps: DiscoveryDeps): Promise<ExtractStats> {
  const { SourceArticle } = await getModels();
  const { config } = deps;
  const now = deps.now();
  const freshSince = new Date(now.getTime() - config.freshnessDays * DAY_MS);

  const expired = await SourceArticle.updateMany(
    { origin: 'discovery', extractionStatus: 'pending', retrievedAt: { $lt: freshSince } },
    { $set: { extractionStatus: 'expired', expiredAt: now, expiredStage: 'extract' } },
  );
  const pending = await SourceArticle.find({ origin: 'discovery', extractionStatus: 'pending' })
    .select({ content: 0, revisions: 0 })
    .lean();
  const ordered = fairOrder(pending.map((a) => ({ ...articleIntake(a), article: a })));
  const selected = ordered.slice(0, config.maxExtract).map((o) => o.article);
  const stats: ExtractStats = {
    requested: selected.length,
    extracted: 0,
    extractionFailures: 0,
    waiting: ordered.length - selected.length,
    expired: expired.modifiedCount,
    fromBacklog: selected.filter((a) => a.firstRunKey !== runKey).length,
  };
  if (selected.length === 0) return stats;

  // Claimed by this run before the request, so a resumed run finishes the same articles.
  await SourceArticle.updateMany(
    { _id: { $in: selected.map((a) => a._id) }, extractionStatus: 'pending' },
    { $set: { intakeRunKey: runKey } },
  );
  const { pages } = await deps.search.extract(
    selected.map((a) => a.url),
    { runKey },
  );
  const byCanonical = new Map(selected.map((a) => [a.canonicalUrl, a]));
  const done = new Set<string>();

  for (const page of pages) {
    const canonical = canonicalizeUrl(page.url);
    const article = canonical ? byCanonical.get(canonical) : undefined;
    if (!article || !page.content.trim() || done.has(article.canonicalUrl)) continue;
    const content = page.content.slice(0, config.storedContentChars);
    const image = pickPreviewImage(page.images, page.content);
    const result = await SourceArticle.updateOne(
      { _id: article._id, extractionStatus: 'pending' },
      {
        $set: {
          content,
          contentHash: contentHash(content),
          extractionStatus: 'extracted',
          lastCheckedAt: now,
          ...(image ? { image: { ...image, capturedAt: now, rights: 'unverified' } } : {}),
          ...(page.title && !article.originalHeadline ? { originalHeadline: page.title } : {}),
        },
      },
    );
    done.add(article.canonicalUrl);
    if (result.modifiedCount === 1) stats.extracted += 1;
  }

  const failed = selected.filter((a) => !done.has(a.canonicalUrl));
  for (const article of failed) {
    const result = await SourceArticle.updateOne(
      { _id: article._id, extractionStatus: 'pending' },
      { $set: { extractionStatus: 'failed', content: article.snippet, lastCheckedAt: now } },
    );
    if (result.modifiedCount === 1) stats.extractionFailures += 1;
  }
  return stats;
}
