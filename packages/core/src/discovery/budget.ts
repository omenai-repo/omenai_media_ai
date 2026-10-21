import type { DiscoveryConfig } from './config.js';

/**
 * Tavily's published rates, checked against docs.tavily.com/documentation/api-credits on
 * 2026-10-20: a basic search costs 1 credit; a basic extract costs 1 credit per 5 successful
 * URLs, and failed URLs are free. Discovery uses basic depth for both.
 */
export const SEARCH_CREDITS_PER_QUERY = 1;
export const EXTRACT_PAGES_PER_CREDIT = 5;

/**
 * Credits kept free for research in the same 24 hours: one in-depth brief (3 searches and up to
 * 10 pages, 2 extract credits). A planning figure for the warning in `pnpm env:check`, not a limit.
 */
export const RESEARCH_CREDIT_RESERVE = 5;

/** The most one discovery run can spend on search: every query, a full extract and revisits. */
export function worstCaseRunCredits(
  config: Pick<DiscoveryConfig, 'maxQueries' | 'maxExtract' | 'maxRevisits'>,
): number {
  return (
    config.maxQueries * SEARCH_CREDITS_PER_QUERY +
    Math.ceil(config.maxExtract / EXTRACT_PAGES_PER_CREDIT) +
    Math.ceil(config.maxRevisits / EXTRACT_PAGES_PER_CREDIT)
  );
}

export interface SearchBudgetFit {
  worstCase: number;
  limit: number | null;
  /** Null when no daily limit is set. */
  fits: boolean | null;
  note: string;
}

/** Whether one run, plus the research reserve, fits under the daily search-credit limit. */
export function searchBudgetFit(
  config: Pick<DiscoveryConfig, 'maxQueries' | 'maxExtract' | 'maxRevisits'>,
  limit: number | null,
): SearchBudgetFit {
  const worstCase = worstCaseRunCredits(config);
  const breakdown = `${config.maxQueries} searches + ${Math.ceil(config.maxExtract / EXTRACT_PAGES_PER_CREDIT)} for up to ${config.maxExtract} pages + ${Math.ceil(config.maxRevisits / EXTRACT_PAGES_PER_CREDIT)} for up to ${config.maxRevisits} revisits`;
  if (limit === null)
    return {
      worstCase,
      limit,
      fits: null,
      note: `up to ${worstCase} credits a run (${breakdown}); no daily limit set`,
    };
  const fits = worstCase + RESEARCH_CREDIT_RESERVE <= limit;
  return {
    worstCase,
    limit,
    fits,
    note: fits
      ? `up to ${worstCase} credits a run (${breakdown}); with ${RESEARCH_CREDIT_RESERVE} kept for research, fits the limit of ${limit}`
      : `up to ${worstCase} credits a run (${breakdown}); with ${RESEARCH_CREDIT_RESERVE} kept for research, that passes the limit of ${limit}`,
  };
}
