import type { UsageContext } from '../llm/types.js';

/** Provider-neutral search contracts; pipeline stages depend on these, not on Tavily. */
export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  /** Provider date string as received (parsed during normalisation). */
  publishedDate: string | null;
  score: number;
}

export interface ExtractedPage {
  url: string;
  title: string | null;
  content: string;
}

export interface SearchOptions {
  maxResults: number;
  timeRange: 'day' | 'week' | 'month';
  languages: readonly string[];
  excludeDomains?: readonly string[];
}

export interface SearchClient {
  search(query: string, options: SearchOptions, context?: UsageContext): Promise<SearchHit[]>;
  extract(
    urls: readonly string[],
    context?: UsageContext,
  ): Promise<{ pages: ExtractedPage[]; failed: Array<{ url: string; error: string }> }>;
}

export type SearchErrorKind = 'rate_limited' | 'unavailable' | 'auth' | 'quota' | 'invalid_request';

export class SearchError extends Error {
  override readonly name = 'SearchError';
  readonly retryable: boolean;

  constructor(
    readonly kind: SearchErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, { cause: options?.cause });
    this.retryable = kind === 'rate_limited' || kind === 'unavailable';
  }
}
