import { usageLimits } from '../config/runtime.js';
import { getModels } from '../db/models.js';
import { AppError } from '../errors.js';

/**
 * Hard usage limits over a rolling 24 hours (`AI_DAILY_CALL_LIMIT`, `SEARCH_DAILY_CREDIT_LIMIT`;
 * required in live development). Checked before every real provider request, from the usage
 * records we already keep, so no retry, duplicate trigger or stale page can spend past them.
 * Simulated (fixture) usage never counts. Concurrent requests can overshoot by at most the
 * number running at once (assessments run three at a time).
 */
export const BUDGET_WINDOW_MS = 24 * 60 * 60_000;

export class UsageLimitError extends AppError {
  constructor(message: string) {
    super('USAGE_LIMIT', message, 429);
  }
}

export interface UsageInWindow {
  aiCalls: number;
  searchCredits: number;
  since: Date;
}

/**
 * AI calls made (failed ones included: they were requests all the same) and search credits used.
 * A successful Tavily request that didn't report its credits counts as one.
 */
export async function usageInWindow(now: Date = new Date()): Promise<UsageInWindow> {
  const { AiUsage } = await getModels();
  const since = new Date(now.getTime() - BUDGET_WINDOW_MS);
  const [row] = await AiUsage.aggregate<{ aiCalls: number; searchCredits: number }>([
    { $match: { createdAt: { $gte: since }, simulated: { $ne: true } } },
    {
      $group: {
        _id: null,
        aiCalls: { $sum: { $cond: [{ $eq: ['$kind', 'llm'] }, 1, 0] } },
        searchCredits: {
          $sum: {
            $cond: [
              { $eq: ['$provider', 'tavily'] },
              { $ifNull: ['$units', { $cond: [{ $eq: ['$outcome', 'ok'] }, 1, 0] }] },
              0,
            ],
          },
        },
      },
    },
  ]);
  return { aiCalls: row?.aiCalls ?? 0, searchCredits: row?.searchCredits ?? 0, since };
}

/** Before an AI call: refuses once the limit is reached. */
export async function assertAiBudget(now: Date = new Date()): Promise<void> {
  const { aiCalls } = usageLimits();
  if (aiCalls === null) return;
  const used = await usageInWindow(now);
  if (used.aiCalls >= aiCalls)
    throw new UsageLimitError(
      `The usage limit of ${aiCalls} AI calls in 24 hours has been reached (AI_DAILY_CALL_LIMIT). Nothing more is sent until older calls age out or the limit is raised.`,
    );
}

/** Before a search or extract request: refuses if its credits would pass the limit. */
export async function assertSearchBudget(credits: number, now: Date = new Date()): Promise<void> {
  const { searchCredits } = usageLimits();
  if (searchCredits === null) return;
  const used = await usageInWindow(now);
  if (used.searchCredits + credits > searchCredits)
    throw new UsageLimitError(
      `The usage limit of ${searchCredits} search credits in 24 hours would be passed (SEARCH_DAILY_CREDIT_LIMIT; ${used.searchCredits} used). Nothing more is sent until older requests age out or the limit is raised.`,
    );
}
