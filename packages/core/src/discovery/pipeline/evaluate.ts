import {
  applyGates,
  bestTier,
  classifyEvaluated,
  EXCLUSIONS,
  recommendedActionFor,
  scoreBand,
  SCORING_DIMENSION_IDS,
  weightedTotal,
  type CandidateOutcome,
  type DimensionScores,
  type ExclusionId,
  type KeyClaimCheck,
} from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../../db/models.js';
import type { SourceArticleDoc } from '../../db/models/source-article.js';
import type { StoryDoc } from '../../db/models/story.js';
import type { LlmResult, ModelTier } from '../../llm/types.js';
import {
  checkClaim,
  flagConflicts,
  type CheckedClaim,
  type CitableSource,
} from '../../research/citations.js';
import { excerpt } from '../normalize.js';
import { EVALUATION_SYSTEM_PROMPT } from '../prompts.js';
import { getRun, tryUseEscalation } from '../runs.js';
import { evaluationOutputSchema, type EvaluationOutput } from '../schemas.js';
import type { DiscoveryDeps } from './context.js';

export interface EvaluateResult {
  outcome: CandidateOutcome;
  total: number | null;
  escalated: boolean;
  skipped: boolean;
}

function date(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : 'date unknown';
}

/** The exact text the evaluator is shown for each article: what its quotes are checked against. */
export function evaluatedTexts(
  articles: readonly SourceArticleDoc[],
  excerptChars: number,
): string[] {
  return articles.map((a) => excerpt(a.content || a.snippet, excerptChars));
}

/** Exclusion signals triage raised on these articles, each to be confirmed or dismissed. */
export function triageSignalsOf(articles: readonly SourceArticleDoc[]): ExclusionId[] {
  const known = new Set<string>(EXCLUSIONS.ids);
  return [
    ...new Set(
      articles.flatMap((a) => (a.triage?.exclusionSignals ?? []).filter((id) => known.has(id))),
    ),
  ] as ExclusionId[];
}

export function evaluationPrompt(
  story: StoryDoc,
  articles: readonly SourceArticleDoc[],
  parent: StoryDoc | null,
  excerptChars: number,
): string {
  const context =
    story.relation === 'new_development' && parent
      ? `This is a NEW DEVELOPMENT related to an earlier story: "${parent.headline}" (first seen ${date(parent.createdAt)}).`
      : story.relation === 'same_development_new_info'
        ? 'This is an UPDATE: the same development as a story we already track, with new material information. Assess it as it now stands.'
        : 'This is a new candidate development.';
  const texts = evaluatedTexts(articles, excerptChars);
  const sources = articles
    .map(
      (a, i) =>
        `A${i + 1} | ${a.publisher} | published ${date(a.publishedAt)} | ${a.originalHeadline}\n` +
        `${a.extractionStatus === 'extracted' ? '' : '[snippet only; full text unavailable]\n'}` +
        texts[i],
    )
    .join('\n---\n');
  const signals = articles.flatMap((a, i) => {
    const ids = triageSignalsOf([a]);
    return ids.length ? [`A${i + 1}: ${ids.join(', ')}`] : [];
  });
  const signalBlock = signals.length
    ? `\n\nTRIAGE SIGNALS (confirm each as an exclusion or dismiss it with a reason):\n${signals.join('\n')}`
    : '';
  return `${context}\n\nSOURCES:\n${sources}${signalBlock}`;
}

/** Stored wording for a key claim's check: never "verified", because a pass proves nothing. */
export const KEY_CLAIM_STATUSES = [
  'no_defect_found',
  'quote_not_found',
  'detail_not_in_quote',
  'quote_unrelated',
  'conflicting',
  'unknown_source',
] as const;
export type KeyClaimStatus = (typeof KEY_CLAIM_STATUSES)[number];

const STATUS_OF: Record<CheckedClaim['citationStatus'], KeyClaimStatus> = {
  verified: 'no_defect_found',
  excerpt_not_located: 'quote_not_found',
  detail_not_in_excerpt: 'detail_not_in_quote',
  excerpt_unrelated: 'quote_unrelated',
  conflicting: 'conflicting',
  uncited: 'quote_not_found',
};

const PROBLEM_OF: Record<Exclude<KeyClaimStatus, 'no_defect_found'>, string> = {
  quote_not_found: 'its quote was not found in the cited source',
  detail_not_in_quote: 'its quote lacks a date, figure or quoted words the claim gives',
  quote_unrelated: 'its quote is about something else',
  conflicting: 'the sources give different dates or figures for it',
  unknown_source: 'it cites a source label we did not provide',
};

export interface CheckedKeyClaim {
  statement: string;
  type: 'fact' | 'attributed';
  sourceLabels: string[];
  sourceArticleIds: string[];
  quote: string;
  status: KeyClaimStatus;
}

/**
 * Runs the shared statement checks (research/citations.ts) over the key claims, against the text
 * the evaluator was shown. Deterministic, no model call; each check can only lower a claim.
 */
export function checkKeyClaims(
  claims: EvaluationOutput['keyClaims'],
  articles: readonly SourceArticleDoc[],
  texts: readonly string[],
): { stored: CheckedKeyClaim[]; gate: KeyClaimCheck[] } {
  const sources = new Map<string, CitableSource>(
    articles.map((a, i) => [
      `A${i + 1}`,
      { label: `A${i + 1}`, id: String(a._id), text: texts[i]! },
    ]),
  );
  const results = claims.map((claim) =>
    checkClaim(
      { type: claim.type, text: claim.statement, sources: claim.sources, excerpt: claim.quote },
      sources,
    ),
  );
  flagConflicts(results.flatMap((r) => ('claim' in r ? [r.claim] : [])));
  const stored = results.map((result, i): CheckedKeyClaim => {
    const claim = claims[i]!;
    return 'claim' in result
      ? {
          statement: claim.statement,
          type: claim.type,
          sourceLabels: result.claim.sourceLabels,
          sourceArticleIds: result.claim.sourceArticleIds,
          quote: claim.quote,
          status: STATUS_OF[result.claim.citationStatus],
        }
      : {
          statement: claim.statement,
          type: claim.type,
          sourceLabels: result.dropped.labels,
          sourceArticleIds: [],
          quote: claim.quote,
          status: 'unknown_source',
        };
  });
  const gate = stored.map((claim): KeyClaimCheck => ({
    type: claim.type,
    passed: claim.status === 'no_defect_found',
    problem: claim.status === 'no_defect_found' ? null : PROBLEM_OF[claim.status],
    sources: claim.sourceLabels
      .map((label) => Number(label.slice(1)) - 1)
      .filter((i) => i >= 0 && i < articles.length),
  }));
  return { stored, gate };
}

function toDimensionScores(scores: EvaluationOutput['scores']): DimensionScores {
  return Object.fromEntries(
    SCORING_DIMENSION_IDS.map((d) => [d, scores[d].score]),
  ) as DimensionScores;
}

/**
 * Evaluates one candidate story: one primary-tier call, plus at most one escalation if the score
 * is borderline or the model flags conflicting sources or ethics/rights ambiguity, and the run's
 * escalation budget allows. The total is computed here; gates override it. Idempotent: a story
 * already evaluated for this run is returned as-is.
 */
export async function evaluateStory(input: {
  runKey: string;
  storyId: string;
  deps: DiscoveryDeps;
}): Promise<EvaluateResult> {
  const { Story, SourceArticle } = await getModels();
  const { deps } = input;
  const { config } = deps;
  const storyId = new Types.ObjectId(input.storyId);
  const story = await Story.findById(storyId).lean();
  if (!story) throw new Error(`Story ${input.storyId} not found`);
  if (story.evaluation?.status === 'evaluated' && story.evaluation.runKey === input.runKey) {
    return {
      outcome: story.evaluation.outcome ?? 'evaluation_failed',
      total: story.score?.total ?? null,
      escalated: story.evaluation.escalated ?? false,
      skipped: true,
    };
  }

  const articles = await SourceArticle.find({ _id: { $in: story.sourceArticleIds } })
    .sort({ publishedAt: -1 })
    .limit(config.maxArticlesPerEvaluation)
    .lean();
  const parent = story.parentStoryId ? await Story.findById(story.parentStoryId).lean() : null;
  const messages = [
    {
      role: 'user' as const,
      content: evaluationPrompt(story, articles, parent, config.evaluationExcerptChars),
    },
  ];
  const evaluate = (tier: ModelTier): Promise<LlmResult<EvaluationOutput>> =>
    deps.llm.generateObject({
      operation: tier === 'escalation' ? 'discovery.evaluate.escalated' : 'discovery.evaluate',
      tier,
      system: EVALUATION_SYSTEM_PROMPT,
      messages,
      // Room for key-claim quotes (ADR-041).
      maxOutputTokens: 4_500,
      schema: evaluationOutputSchema,
      context: { runKey: input.runKey, storyId: input.storyId },
    });

  let result = await evaluate('primary');
  let total = weightedTotal(toDimensionScores(result.data.scores));
  let escalated = false;
  const borderline = [config.shortlistThreshold, config.priorityThreshold].some(
    (threshold) => Math.abs(total - threshold) <= config.escalationMargin,
  );
  if (
    (result.data.needsEscalation || borderline) &&
    config.maxEscalations > 0 &&
    (await tryUseEscalation(input.runKey, config.maxEscalations))
  ) {
    result = await evaluate('escalation');
    total = weightedTotal(toDimensionScores(result.data.scores));
    escalated = true;
  }

  const out = result.data;
  const now = deps.now();
  const sameDevelopment =
    story.relation === 'same_development_new_info' ||
    story.relation === 'same_development_no_new_info';
  const keyClaims = checkKeyClaims(
    out.keyClaims,
    articles,
    evaluatedTexts(articles, config.evaluationExcerptChars),
  );
  const ratedQuality = new Map(out.sourceQuality.map((r) => [r.ref, r.quality]));
  const knownSignals = new Set<string>(EXCLUSIONS.ids);
  const gates = applyGates({
    now,
    freshnessDays: config.freshnessDays,
    sources: articles.map((a, i) => ({
      url: a.canonicalUrl,
      publisher: a.publisher,
      publishedAt: a.publishedAt ?? null,
      quality: ratedQuality.get(`A${i + 1}`) ?? 'unknown',
      host: a.host,
    })),
    novelty: out.noveltyStatus,
    repeat: story.relation ?? 'new',
    previouslySkipped:
      story.editorialState === 'skipped' ||
      (sameDevelopment && parent?.editorialState === 'skipped'),
    editorialTest: out.editorialTest,
    exclusions: out.exclusions,
    criticalIssues: out.criticalIssues,
    evidence: {
      keyClaims: keyClaims.gate,
      editorialSupport: out.editorialTest.supportedBy,
      pressRelease: out.pressRelease,
    },
    card: { angle: out.angle, whyItMatters: out.whyItMatters },
    triageSignals: triageSignalsOf(articles),
    dismissedSignals: out.dismissedSignals
      .filter((d) => knownSignals.has(d.signal.trim()))
      .map((d) => ({ id: d.signal.trim() as ExclusionId, reason: d.reason })),
  });
  const run = await getRun(input.runKey);
  const late = Boolean(run?.candidateSetClosedAt);
  const outcome: CandidateOutcome = late
    ? 'deferred_late'
    : classifyEvaluated(gates, total, config.shortlistThreshold);
  const band = scoreBand(total, {
    priority: config.priorityThreshold,
    shortlist: config.shortlistThreshold,
  });

  await Story.updateOne(
    { _id: storyId },
    {
      $set: {
        headline: out.headline,
        summary: out.summary,
        whatHappened: out.whatHappened,
        whyItMatters: out.whyItMatters,
        editorialTest: { canAnswer: out.editorialTest.canAnswer, answer: out.editorialTest.answer },
        keyClaims: keyClaims.stored,
        angle: out.angle,
        whyNow: out.whyNow,
        primaryPillar: out.primaryPillar,
        subcategories: out.subcategories,
        crossCuttingTags: out.crossCuttingTags,
        geography: out.geography,
        tier: bestTier(out.geography.map((g) => g.region)),
        culturalConnections: out.culturalConnections,
        entities: out.entities,
        noveltyStatus: out.noveltyStatus,
        timeliness: out.timeliness,
        formatPotential: out.formatPotential,
        verificationNeeds: out.verificationNeeds,
        peopleToApproach: out.peopleToApproach,
        visualOpportunities: out.visualOpportunities,
        score: {
          dimensions: SCORING_DIMENSION_IDS.map((d) => ({
            dimension: d,
            score: out.scores[d].score,
            rationale: out.scores[d].rationale,
          })),
          total,
          band,
          confidence: out.confidence,
        },
        gates,
        recommendedAction: recommendedActionFor(outcome, band, out.timeliness),
        evaluation: {
          status: 'evaluated',
          runKey: input.runKey,
          outcome,
          model: result.model,
          escalated,
          evaluatedAt: now,
          error: null,
        },
      },
    },
  );

  // Record the model's source-quality judgement on the articles it saw (by label, never by URL).
  for (const { ref, quality } of out.sourceQuality) {
    const article = articles[Number(ref.slice(1)) - 1];
    if (article)
      await SourceArticle.updateOne({ _id: article._id }, { $set: { sourceQuality: quality } });
  }

  return { outcome, total, escalated, skipped: false };
}

/**
 * Marks an evaluation failed after its retries are exhausted. The first such failure is retried
 * once in the next run; a second is final. Idempotent per run: a repeated call for the same run
 * doesn't count twice.
 */
export async function markEvaluationFailed(
  runKey: string,
  storyId: string,
  message: string,
): Promise<void> {
  const { Story } = await getModels();
  await Story.updateOne(
    {
      _id: new Types.ObjectId(storyId),
      $nor: [{ 'evaluation.status': 'failed', 'evaluation.runKey': runKey }],
    },
    {
      $set: {
        'evaluation.status': 'failed',
        'evaluation.runKey': runKey,
        'evaluation.outcome': 'evaluation_failed',
        'evaluation.error': message.slice(0, 1_000),
      },
      $inc: { 'evaluation.failedRuns': 1 },
    },
  );
}
