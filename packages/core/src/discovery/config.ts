import { SCORE_THRESHOLDS } from '@repo/shared';
import * as z from 'zod';

import { ConfigError } from '../config/env.js';

/**
 * Discovery limits. Conservative defaults keep API spend low; each can be overridden by an
 * environment variable (documented in docs/IMPLEMENTATION_PLAN.md) and should be tuned only
 * after observing real runs.
 */
const schema = z.object({
  maxQueries: z.coerce.number().int().min(1).max(30).default(10),
  resultsPerQuery: z.coerce.number().int().min(1).max(20).default(8),
  searchTimeRange: z.enum(['day', 'week', 'month']).default('week'),
  languages: z
    .string()
    .default('en')
    .transform((value) =>
      value
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean),
    ),
  maxExtract: z.coerce.number().int().min(0).max(200).default(60),
  maxRevisits: z.coerce.number().int().min(0).max(50).default(10),
  revisitIntervalHours: z.coerce.number().min(1).default(48),
  revisitWindowDays: z.coerce.number().min(1).default(14),
  maxEvaluations: z.coerce.number().int().min(1).max(100).default(25),
  maxEscalations: z.coerce.number().int().min(0).max(25).default(4),
  escalationMargin: z.coerce.number().min(0).max(20).default(4),
  freshnessDays: z.coerce.number().min(1).default(14),
  shortlistMax: z.coerce.number().int().min(1).max(20).default(8),
  shortlistTargetMin: z.coerce.number().int().min(0).max(20).default(5),
  shortlistThreshold: z.coerce.number().min(0).max(100).default(SCORE_THRESHOLDS.shortlist),
  priorityThreshold: z.coerce.number().min(0).max(100).default(SCORE_THRESHOLDS.priority),
  softDeadlineMinutes: z.coerce.number().min(5).default(120),
  extensionDeadlineMinutes: z.coerce.number().min(5).default(180),
  hardDeadlineMinutes: z.coerce.number().min(5).default(240),
  minCandidates: z.coerce.number().int().min(0).default(3),
  // Long enough to cover the longest stage between heartbeats.
  leaseMinutes: z.coerce.number().min(1).default(30),
  // Six, not eight: a failed batch is split rather than rewritten whole (ADR-046), and a smaller
  // first batch keeps one overlong answer from costing the rest of the batch.
  triageBatchSize: z.coerce.number().int().min(1).max(20).default(6),
  triageExcerptChars: z.coerce.number().int().min(200).default(1_500),
  evaluationExcerptChars: z.coerce.number().int().min(500).default(6_000),
  maxArticlesPerEvaluation: z.coerce.number().int().min(1).max(10).default(4),
  clusterMaxItems: z.coerce.number().int().min(2).max(150).default(60),
  recentStoryWindowDays: z.coerce.number().min(1).default(21),
  recentStoryMax: z.coerce.number().int().min(0).max(200).default(80),
  /** Revisited text at least this similar to the stored version is a cosmetic change (no AI). */
  cosmeticSimilarity: z.coerce.number().min(0).max(1).default(0.97),
  storedContentChars: z.coerce.number().int().min(1_000).default(12_000),
});

export type DiscoveryConfig = z.output<typeof schema>;

const ENV: Record<keyof DiscoveryConfig, string> = {
  maxQueries: 'DISCOVERY_MAX_QUERIES',
  resultsPerQuery: 'DISCOVERY_RESULTS_PER_QUERY',
  searchTimeRange: 'DISCOVERY_TIME_RANGE',
  languages: 'DISCOVERY_LANGUAGES',
  maxExtract: 'DISCOVERY_MAX_EXTRACT',
  maxRevisits: 'DISCOVERY_MAX_REVISITS',
  revisitIntervalHours: 'DISCOVERY_REVISIT_INTERVAL_HOURS',
  revisitWindowDays: 'DISCOVERY_REVISIT_WINDOW_DAYS',
  maxEvaluations: 'DISCOVERY_MAX_EVALUATIONS',
  maxEscalations: 'AI_MAX_ESCALATIONS_PER_RUN',
  escalationMargin: 'AI_ESCALATION_MARGIN',
  freshnessDays: 'DISCOVERY_FRESHNESS_DAYS',
  shortlistMax: 'SHORTLIST_MAX',
  shortlistTargetMin: 'SHORTLIST_TARGET_MIN',
  shortlistThreshold: 'SCORE_SHORTLIST_THRESHOLD',
  priorityThreshold: 'SCORE_PRIORITY_THRESHOLD',
  softDeadlineMinutes: 'RUN_SOFT_DEADLINE_MINUTES',
  extensionDeadlineMinutes: 'RUN_EXTENSION_DEADLINE_MINUTES',
  hardDeadlineMinutes: 'RUN_HARD_DEADLINE_MINUTES',
  minCandidates: 'RUN_MIN_CANDIDATES',
  leaseMinutes: 'RUN_LEASE_MINUTES',
  triageBatchSize: 'DISCOVERY_TRIAGE_BATCH',
  triageExcerptChars: 'DISCOVERY_TRIAGE_EXCERPT_CHARS',
  evaluationExcerptChars: 'DISCOVERY_EVALUATION_EXCERPT_CHARS',
  maxArticlesPerEvaluation: 'DISCOVERY_MAX_ARTICLES_PER_EVALUATION',
  clusterMaxItems: 'DISCOVERY_CLUSTER_MAX_ITEMS',
  recentStoryWindowDays: 'DISCOVERY_RECENT_STORY_DAYS',
  recentStoryMax: 'DISCOVERY_RECENT_STORY_MAX',
  cosmeticSimilarity: 'DISCOVERY_COSMETIC_SIMILARITY',
  storedContentChars: 'DISCOVERY_STORED_CONTENT_CHARS',
};

export function readDiscoveryConfig(env: NodeJS.ProcessEnv = process.env): DiscoveryConfig {
  const raw = Object.fromEntries(
    Object.entries(ENV).flatMap(([key, variable]) => {
      const value = env[variable]?.trim();
      return value ? [[key, value]] : [];
    }),
  );
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const key = issue.path[0] as keyof DiscoveryConfig;
    throw new ConfigError(ENV[key] ?? String(key), issue.message);
  }
  const config = parsed.data;
  if (!(
    config.softDeadlineMinutes <= config.extensionDeadlineMinutes &&
    config.extensionDeadlineMinutes <= config.hardDeadlineMinutes
  )) {
    throw new ConfigError('RUN_*_DEADLINE_MINUTES', 'soft ≤ extension ≤ hard is required');
  }
  return config;
}
