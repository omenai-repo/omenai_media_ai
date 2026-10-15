import { getModels } from '../../db/models.js';
import { SearchError } from '../../search/types.js';
import { canonicalizeUrl, hostOf, parseDate, publisherName } from '../normalize.js';
import { recordRunError } from '../runs.js';
import { EXCLUDED_DOMAINS, selectQueries } from '../sources.js';
import type { DiscoveryDeps } from './context.js';

export interface DiscoverStats extends Record<string, unknown> {
  searchQueries: number;
  searchFailures: number;
  discovered: number;
  newArticles: number;
  reappeared: number;
}

/**
 * Searches the day's rotated queries and upserts every result by canonical URL. Articles seen for
 * the first time get `firstRunKey`; known ones get `lastSeenRunKey`, which marks them for a
 * possible revisit. A failing query is counted and skipped; bad credentials or an exhausted
 * quota stop the run, because no later query could succeed either.
 */
export async function discoverStage(
  runKey: string,
  queryDate: string,
  deps: DiscoveryDeps,
): Promise<DiscoverStats> {
  const { config } = deps;
  const queries = selectQueries(queryDate, config.maxQueries);
  const best = new Map<
    string,
    {
      url: string;
      title: string;
      snippet: string;
      publishedDate: string | null;
      score: number;
      query: string;
    }
  >();
  let failures = 0;

  for (const { query } of queries) {
    try {
      const hits = await deps.search.search(
        query,
        {
          maxResults: config.resultsPerQuery,
          timeRange: config.searchTimeRange,
          languages: config.languages,
          excludeDomains: EXCLUDED_DOMAINS,
        },
        { runKey },
      );
      for (const hit of hits) {
        const canonical = canonicalizeUrl(hit.url);
        if (!canonical) continue;
        const existing = best.get(canonical);
        if (!existing || hit.score > existing.score) best.set(canonical, { ...hit, query });
      }
    } catch (error) {
      if (error instanceof SearchError && (error.kind === 'auth' || error.kind === 'quota'))
        throw error;
      failures += 1;
      await recordRunError(runKey, 'discover', `Query "${query}" failed: ${String(error)}`);
    }
  }

  const { SourceArticle } = await getModels();
  const now = deps.now();
  let newArticles = 0;
  for (const [canonicalUrl, hit] of best) {
    const host = hostOf(canonicalUrl);
    const result = await SourceArticle.updateOne(
      { canonicalUrl },
      {
        $setOnInsert: {
          canonicalUrl,
          url: hit.url,
          host,
          publisher: publisherName(host),
          originalHeadline: hit.title.trim() || canonicalUrl,
          publishedAt: parseDate(hit.publishedDate),
          retrievedAt: now,
          origin: 'discovery',
          snippet: hit.snippet.slice(0, 2_000),
          firstRunKey: runKey,
          searchQuery: hit.query,
          searchScore: hit.score,
        },
        $set: { lastSeenRunKey: runKey },
      },
      { upsert: true },
    );
    if (result.upsertedCount === 1) newArticles += 1;
  }

  return {
    searchQueries: queries.length,
    searchFailures: failures,
    discovered: best.size,
    newArticles,
    reappeared: best.size - newArticles,
  };
}
