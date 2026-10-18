import { tavily } from '@tavily/core';

import { getModels } from '../db/models.js';
import type { UsageContext } from '../llm/types.js';
import {
  SearchError,
  type ExtractedPage,
  type SearchClient,
  type SearchErrorKind,
} from './types.js';

/**
 * @tavily/core 0.7 throws plain Errors and drops the HTTP status, so failures are classified
 * from the message. Unknown errors are treated as transient so a later attempt can succeed.
 */
export function classifyTavilyError(message: string): SearchErrorKind {
  if (/api key|unauthori[sz]ed|forbidden|\b40[13]\b/i.test(message)) return 'auth';
  if (/usage limit|plan limit|credits|\b43[23]\b/i.test(message)) return 'quota';
  if (/\b429\b|rate limit|too many requests/i.test(message)) return 'rate_limited';
  if (/\b400\b|invalid|bad request/i.test(message)) return 'invalid_request';
  return 'unavailable';
}

function toSearchError(error: unknown, operation: string): SearchError {
  const message = error instanceof Error ? error.message : String(error);
  return new SearchError(classifyTavilyError(message), `Tavily ${operation} failed: ${message}`, {
    cause: error,
  });
}

async function recordUsage(input: {
  kind: 'search' | 'extract';
  operation: string;
  credits: number | null;
  outcome: 'ok' | 'error';
  errorKind?: string;
  context?: UsageContext;
}): Promise<void> {
  try {
    const { AiUsage } = await getModels();
    await AiUsage.create({
      provider: 'tavily',
      kind: input.kind,
      operation: input.operation,
      units: input.credits,
      outcome: input.outcome,
      errorKind: input.errorKind ?? null,
      runKey: input.context?.runKey ?? null,
      taskId: input.context?.taskId ?? null,
      storyId: input.context?.storyId ?? null,
    });
  } catch (error) {
    console.error('Failed to record Tavily usage', error);
  }
}

/** Tavily extract accepts at most 20 URLs per request. */
const EXTRACT_BATCH = 20;

export function createTavilySearchClient(options: { apiKey: string }): SearchClient {
  const client = tavily({ apiKey: options.apiKey });

  return {
    async search(query, searchOptions, context) {
      try {
        const response = await client.search(query, {
          topic: searchOptions.topic ?? 'news',
          searchDepth: 'basic',
          timeRange: searchOptions.timeRange,
          maxResults: searchOptions.maxResults,
          excludeDomains: [...(searchOptions.excludeDomains ?? [])],
          // English-only discovery is a documented MVP limitation (DISCOVERY_LANGUAGES).
          ...(searchOptions.languages.length === 1 ? { language: searchOptions.languages[0] } : {}),
          includeUsage: true,
        });
        await recordUsage({
          kind: 'search',
          operation: `${searchOptions.purpose ?? 'discovery'}.search`,
          credits: response.usage?.credits ?? null,
          outcome: 'ok',
          context,
        });
        return response.results.map((r) => ({
          url: r.url,
          title: r.title,
          snippet: r.content,
          publishedDate: r.publishedDate || null,
          score: r.score,
        }));
      } catch (error) {
        const searchError = toSearchError(error, 'search');
        await recordUsage({
          kind: 'search',
          operation: `${searchOptions.purpose ?? 'discovery'}.search`,
          credits: null,
          outcome: 'error',
          errorKind: searchError.kind,
          context,
        });
        throw searchError;
      }
    },

    async extract(urls, context, extractOptions) {
      const operation = `${extractOptions?.purpose ?? 'discovery'}.extract`;
      const pages: ExtractedPage[] = [];
      const failed: Array<{ url: string; error: string }> = [];
      for (let i = 0; i < urls.length; i += EXTRACT_BATCH) {
        const batch = urls.slice(i, i + EXTRACT_BATCH);
        try {
          const response = await client.extract([...batch], {
            extractDepth: 'basic',
            format: 'markdown',
            // Preview-image candidates for the story card (no model call; credit effect unverified).
            includeImages: true,
            includeUsage: true,
          });
          await recordUsage({
            kind: 'extract',
            operation,
            credits: response.usage?.credits ?? null,
            outcome: 'ok',
            context,
          });
          pages.push(
            ...response.results.map((r) => ({
              url: r.url,
              title: r.title,
              content: r.rawContent,
              images: (r.images ?? []).filter((i): i is string => typeof i === 'string'),
            })),
          );
          failed.push(...response.failedResults.map((f) => ({ url: f.url, error: f.error })));
        } catch (error) {
          const searchError = toSearchError(error, 'extract');
          await recordUsage({
            kind: 'extract',
            operation,
            credits: null,
            outcome: 'error',
            errorKind: searchError.kind,
            context,
          });
          // Permanent failures stop the stage; transient ones fail only this batch.
          if (!searchError.retryable) throw searchError;
          failed.push(...batch.map((url) => ({ url, error: searchError.message })));
        }
      }
      return { pages, failed };
    },
  };
}
