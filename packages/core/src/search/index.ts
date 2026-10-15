import { requireEnv } from '../config/env.js';
import { createTavilySearchClient } from './tavily.js';
import type { SearchClient } from './types.js';

export * from './types.js';
export { classifyTavilyError, createTavilySearchClient } from './tavily.js';

let cached: SearchClient | undefined;

export function getSearchClient(): SearchClient {
  cached ??= createTavilySearchClient({ apiKey: requireEnv('TAVILY_API_KEY') });
  return cached;
}
