import {
  applyGates,
  bestTier,
  classifyEvaluated,
  recommendedActionFor,
  scoreBand,
  SCORING_DIMENSION_IDS,
  weightedTotal,
  type CandidateOutcome,
  type DimensionScores,
} from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../../db/models.js';
import type { SourceArticleDoc } from '../../db/models/source-article.js';
import type { StoryDoc } from '../../db/models/story.js';
import type { LlmResult, ModelTier } from '../../llm/types.js';
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
  const sources = articles
    .map(
      (a, i) =>
        `A${i + 1} | ${a.publisher} | published ${date(a.publishedAt)} | ${a.originalHeadline}\n` +
        `${a.extractionStatus === 'extracted' ? '' : '[snippet only; full text unavailable]\n'}` +
        excerpt(a.content || a.snippet, excerptChars),
    )
    .join('\n---\n');
  return `${context}\n\nSOURCES:\n${sources}`;
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
      maxOutputTokens: 3_500,
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
  const gates = applyGates({
    now,
    freshnessDays: config.freshnessDays,
    sources: articles.map((a) => ({
      url: a.canonicalUrl,
      publisher: a.publisher,
      publishedAt: a.publishedAt ?? null,
    })),
    novelty: out.noveltyStatus,
    repeat: story.relation ?? 'new',
    previouslySkipped:
      story.editorialState === 'skipped' ||
      (sameDevelopment && parent?.editorialState === 'skipped'),
    editorialTest: out.editorialTest,
    exclusions: out.exclusions,
    criticalIssues: out.criticalIssues,
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
        editorialTest: out.editorialTest,
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

/** Marks an evaluation as permanently failed after retries are exhausted. */
export async function markEvaluationFailed(
  runKey: string,
  storyId: string,
  message: string,
): Promise<void> {
  const { Story } = await getModels();
  await Story.updateOne(
    { _id: new Types.ObjectId(storyId) },
    {
      $set: {
        'evaluation.status': 'failed',
        'evaluation.runKey': runKey,
        'evaluation.outcome': 'evaluation_failed',
        'evaluation.error': message.slice(0, 1_000),
      },
    },
  );
}
