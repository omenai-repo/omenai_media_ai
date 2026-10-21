import { requireEnv } from '../config/env.js';
import { EXTRACT_PAGES_PER_CREDIT, SEARCH_CREDITS_PER_QUERY } from '../discovery/budget.js';
import { assertSearchBudget } from '../ops/budget.js';
import { createTavilySearchClient } from './tavily.js';
import type { SearchClient } from './types.js';

export * from './types.js';
export { classifyTavilyError, createTavilySearchClient } from './tavily.js';

let cached: SearchClient | undefined;

/**
 * The process-wide search client. Every request first passes the daily credit limit (required in
 * live development), counting the most it could cost: one credit per basic search, one per five
 * pages extracted.
 */
export function getSearchClient(): SearchClient {
  if (!cached) {
    const client = createTavilySearchClient({ apiKey: requireEnv('TAVILY_API_KEY') });
    cached = {
      async search(query, options, context) {
        await assertSearchBudget(SEARCH_CREDITS_PER_QUERY);
        return client.search(query, options, context);
      },
      async extract(urls, context, options) {
        await assertSearchBudget(Math.ceil(urls.length / EXTRACT_PAGES_PER_CREDIT));
        return client.extract(urls, context, options);
      },
    };
  }
  return cached;
}
