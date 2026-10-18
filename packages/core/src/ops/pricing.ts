import type { UsageRowDto } from '../newsroom/dto.js';

/**
 * List prices used to *estimate* spend. Providers don't return billed amounts, so these are never
 * presented as actual cost; the provider dashboards are the source of truth. Update the table
 * (and `verifiedOn`) when prices change.
 */
export const PRICE_TABLE = {
  verifiedOn: '2026-10-16',
  /** USD per million tokens. Source: Anthropic list prices (Claude API reference, cached 2026-10-06). */
  anthropic: {
    'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 },
    'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2 },
    'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  } as Record<string, { input: number; output: number; cacheRead: number }>,
  /**
   * USD per million tokens, paid tier; thinking tokens are billed as output. Source:
   * ai.google.dev/gemini-api/docs/pricing, checked 2026-10-16 (3.8 Flash at its price through
   * 2026-12-31). The free tier charges nothing, but the app can't see which tier a key is on, so
   * estimates use the paid price and say so.
   */
  gemini: {
    'gemini-3.8-flash': { input: 0.75, output: 3.75 },
    'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
    'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  } as Record<string, { input: number; output: number }>,
  /** Source: tavily.com/pricing, Pay As You Go. The free Researcher plan includes 1,000 credits a month. */
  tavily: { perCredit: 0.008, freeCreditsPerMonth: 1_000 },
} as const;

export type CostBasis = 'list_price' | 'free_tier' | 'unreported' | 'unknown';

export interface CostEstimate {
  usd: number | null;
  basis: CostBasis;
  note: string;
}

/**
 * Estimated cost of one usage row. Anthropic output tokens already include thinking tokens, so
 * reasoning is not added again; cache writes aren't recorded, so Anthropic estimates run slightly low.
 */
export function estimateRowCost(row: UsageRowDto): CostEstimate {
  if (row.provider === 'tavily' && row.unreportedCalls > 0) {
    // A partial total would understate spend, so give no figure until credits are known.
    return {
      usd: null,
      basis: 'unreported',
      note: `${row.unreportedCalls} ${row.unreportedCalls === 1 ? 'request' : 'requests'} didn't report credit use, so there's no estimate yet.`,
    };
  }
  if (row.provider === 'tavily') {
    return {
      usd: row.units * PRICE_TABLE.tavily.perCredit,
      basis: 'list_price',
      note: `Pay-as-you-go rate of $${PRICE_TABLE.tavily.perCredit} per credit; the free plan includes ${PRICE_TABLE.tavily.freeCreditsPerMonth.toLocaleString('en-US')} credits a month.`,
    };
  }
  if (row.provider === 'gemini') {
    const price = row.model ? PRICE_TABLE.gemini[row.model] : undefined;
    if (!price)
      return {
        usd: null,
        basis: 'unknown',
        note: 'No price on file for this model, so no estimate.',
      };
    return {
      usd:
        (row.inputTokens * price.input + (row.outputTokens + row.reasoningTokens) * price.output) /
        1_000_000,
      basis: 'list_price',
      note: `Gemini paid-tier list price for ${row.model}, thinking included. No charge if this key is on the free tier, which the app can’t see.`,
    };
  }
  if (row.provider === 'anthropic' && row.model) {
    const price = PRICE_TABLE.anthropic[row.model];
    if (price) {
      const usd =
        (row.inputTokens * price.input +
          row.outputTokens * price.output +
          row.cachedInputTokens * price.cacheRead) /
        1_000_000;
      return { usd, basis: 'list_price', note: `Anthropic list price for ${row.model}.` };
    }
  }
  return { usd: null, basis: 'unknown', note: 'No price on file for this model, so no estimate.' };
}

export type UsageGroup = 'finding' | 'assessing' | 'research' | 'content' | 'other';

export const USAGE_GROUP_LABELS: Record<UsageGroup, string> = {
  finding: 'Finding stories',
  assessing: 'Assessing stories',
  research: 'Research',
  content: 'Creating content',
  other: 'Other',
};

export function usageGroupOf(operation: string): UsageGroup {
  if (operation === 'discovery.search' || operation === 'discovery.extract') return 'finding';
  if (operation.startsWith('discovery.')) return 'assessing';
  if (operation.startsWith('research.') || operation.startsWith('chat.')) return 'research';
  if (operation.startsWith('generate.') || operation.startsWith('draft.')) return 'content';
  return 'other';
}

export interface UsageGroupDto {
  group: UsageGroup;
  label: string;
  calls: number;
  errors: number;
  credits: number;
  tokens: number;
  /** Null when any row in the group has no price on file. */
  estimateUsd: number | null;
  /** Every request in the group ran on a free tier, so there is no charge to estimate. */
  freeTier: boolean;
  /** Requests whose provider didn't report usage; the estimate is null while any remain. */
  unreportedCalls: number;
  notes: string[];
}

export function groupUsage(rows: readonly UsageRowDto[]): UsageGroupDto[] {
  const groups = new Map<UsageGroup, UsageGroupDto>();
  for (const row of rows) {
    const group = usageGroupOf(row.operation);
    const current =
      groups.get(group) ??
      ({
        group,
        label: USAGE_GROUP_LABELS[group],
        calls: 0,
        errors: 0,
        credits: 0,
        tokens: 0,
        estimateUsd: 0,
        freeTier: true,
        unreportedCalls: 0,
        notes: [],
      } satisfies UsageGroupDto);
    const cost = estimateRowCost(row);
    current.calls += row.calls;
    current.errors += row.errors;
    current.credits += row.units;
    current.tokens += row.inputTokens + row.outputTokens + row.reasoningTokens;
    current.estimateUsd =
      current.estimateUsd === null || cost.usd === null ? null : current.estimateUsd + cost.usd;
    current.freeTier = current.freeTier && cost.basis === 'free_tier';
    current.unreportedCalls += row.unreportedCalls;
    if (!current.notes.includes(cost.note)) current.notes.push(cost.note);
    groups.set(group, current);
  }
  const order: UsageGroup[] = ['finding', 'assessing', 'research', 'content', 'other'];
  return order.flatMap((g) => (groups.has(g) ? [groups.get(g)!] : []));
}

export interface UsageSummaryDto {
  groups: UsageGroupDto[];
  /** Null when any group has no estimate (unknown price or unreported usage). */
  estimateUsd: number | null;
  /** True when every request ran on a free tier. */
  freeTierOnly: boolean;
}

export function summarizeUsage(rows: readonly UsageRowDto[]): UsageSummaryDto {
  const groups = groupUsage(rows);
  return {
    groups,
    estimateUsd: groups.some((g) => g.estimateUsd === null)
      ? null
      : groups.reduce((sum, g) => sum + (g.estimateUsd ?? 0), 0),
    freeTierOnly: groups.length > 0 && groups.every((g) => g.freeTier),
  };
}

/**
 * Provider-reported usage and fixture (simulated) usage, kept apart so invented activity is
 * never added to, or mistaken for, real consumption.
 */
export function splitUsage(rows: readonly UsageRowDto[]): {
  reported: UsageSummaryDto;
  simulated: UsageSummaryDto | null;
} {
  const simulated = rows.filter((r) => r.simulated);
  return {
    reported: summarizeUsage(rows.filter((r) => !r.simulated)),
    simulated: simulated.length ? summarizeUsage(simulated) : null,
  };
}
