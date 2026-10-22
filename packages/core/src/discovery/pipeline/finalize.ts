import {
  classifyEvaluated,
  deriveShortfallReasons,
  emptyFunnel,
  rankShortlist,
  recommendedActionFor,
  type GateOutcome,
  type CandidateOutcome,
  type Confidence,
  type GeographyTier,
  type RunFunnel,
} from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../../db/models.js';
import { closeCandidateSet, completeRun, getRun } from '../runs.js';
import type { ClusterStats } from './cluster.js';
import type { DiscoveryDeps } from './context.js';
import type { DiscoverStats } from './discover.js';
import type { ExtractStats } from './extract.js';
import type { RevisitStats } from './revisit.js';
import type { TriageStats } from './triage.js';

const DAY_MS = 86_400_000;

/**
 * Decides a carried-over story from its stored gates and score, re-checking freshness against
 * today. The decision is written back so the story isn't carried again.
 */
async function reclassifyCarriedOver(
  story: {
    _id: Types.ObjectId;
    sourceArticleIds: Types.ObjectId[];
    noveltyStatus?: string | null;
    timeliness?: string | null;
    gates?: {
      outcome?: string | null;
      results?: Array<{ gate: string; outcome: string; reason: string }>;
    } | null;
    score?: { total?: number | null; band?: string | null } | null;
  },
  runKey: string,
  now: Date,
  config: DiscoveryDeps['config'],
): Promise<CandidateOutcome> {
  const { SourceArticle, Story } = await getModels();
  const newest = await SourceArticle.findOne({
    _id: { $in: story.sourceArticleIds },
    publishedAt: { $ne: null },
  })
    .sort({ publishedAt: -1 })
    .lean();
  const evergreen = story.noveltyStatus === 'evergreen' || story.noveltyStatus === 'retrospective';
  const ageDays = newest?.publishedAt ? (now.getTime() - newest.publishedAt.getTime()) / DAY_MS : 0;
  const stale = !evergreen && ageDays > config.freshnessDays;
  const results = (story.gates?.results ?? []) as Array<{
    gate: string;
    outcome: GateOutcome;
    reason: string;
  }>;
  const outcome: CandidateOutcome = stale
    ? 'gate_reject'
    : classifyEvaluated(
        { outcome: (story.gates?.outcome ?? 'reject') as GateOutcome, results },
        story.score?.total ?? 0,
        config.shortlistThreshold,
      );
  await Story.updateOne(
    { _id: story._id },
    {
      $set: {
        'evaluation.outcome': outcome,
        'evaluation.runKey': runKey,
        recommendedAction: recommendedActionFor(
          outcome,
          (story.score?.band ?? null) as 'priority' | 'shortlist' | 'below_threshold' | null,
          (story.timeliness ?? null) as 'urgent' | 'this_week' | 'upcoming' | 'evergreen' | null,
        ),
        ...(stale
          ? {
              'gates.outcome': 'reject',
              'gates.results': [
                ...results,
                {
                  gate: 'freshness',
                  outcome: 'reject',
                  reason: `Stale by the time it was ranked (${Math.floor(ageDays)} days).`,
                },
              ],
            }
          : {}),
      },
    },
  );
  return outcome;
}

export interface FinalizeResult {
  shortlist: Array<{ storyId: string; rank: number; score: number; isUpdate: boolean }>;
  funnel: RunFunnel;
  shortfallReasons: ReturnType<typeof deriveShortfallReasons>;
}

type RunOutcome = { storyId: Types.ObjectId; outcome: CandidateOutcome; detail: string };

/**
 * Every candidate's outcome, the funnel and the ranked shortlist, from the stored evaluations
 * (no model call), with each shortlisted story's recommendation recorded once per run. Only
 * `qualified` stories are ranked; the threshold is a fixed input and is never relaxed when few
 * stories qualify. Unevaluated candidates are `deferred_late` and stay pending for the next run.
 */
async function rankRun(
  runKey: string,
  deps: DiscoveryDeps,
  now: Date,
): Promise<FinalizeResult & { outcomes: RunOutcome[]; shortlistIds: Types.ObjectId[] }> {
  const { config } = deps;
  const { Story } = await getModels();
  const run = await getRun(runKey);
  const stats = (run?.stageStats ?? {}) as {
    discover?: DiscoverStats;
    revisit?: RevisitStats;
    extract?: ExtractStats;
    triage?: TriageStats;
    cluster?: ClusterStats;
  };

  const candidates = await Story.find({ lastCandidateRunKey: runKey }).lean();
  const outcomes: RunOutcome[] = [];
  const rankable: Array<{
    id: string;
    outcome: CandidateOutcome;
    total: number;
    confidence: Confidence;
    tier: GeographyTier;
    isUpdate: boolean;
  }> = [];
  const gateRejectsByGate: Record<string, number> = {};

  for (const story of candidates) {
    const evaluation = story.evaluation;
    let outcome: CandidateOutcome;
    if (
      evaluation?.status === 'evaluated' &&
      evaluation.runKey !== runKey &&
      evaluation.outcome === 'deferred_late'
    ) {
      // Evaluated after an earlier run closed: decide now from the stored evaluation.
      outcome = await reclassifyCarriedOver(story, runKey, now, config);
    } else if (
      evaluation?.status === 'evaluated' &&
      evaluation.runKey === runKey &&
      evaluation.outcome
    ) {
      outcome = evaluation.outcome;
    } else if (evaluation?.status === 'failed' && evaluation.runKey === runKey) {
      outcome = 'evaluation_failed';
    } else {
      outcome = 'deferred_late';
    }
    const detail =
      outcome === 'gate_reject' || outcome === 'gate_hold'
        ? (story.gates?.results ?? [])
            .filter((r) => r.outcome !== 'pass')
            .map((r) => r.gate)
            .join(', ')
        : outcome === 'evaluation_failed'
          ? (evaluation?.error ?? '')
          : story.score?.total != null
            ? `score ${story.score.total}`
            : '';
    outcomes.push({ storyId: story._id, outcome, detail });
    if (outcome === 'gate_reject') {
      for (const result of story.gates?.results ?? []) {
        if (result.outcome === 'reject')
          gateRejectsByGate[result.gate] = (gateRejectsByGate[result.gate] ?? 0) + 1;
      }
    }
    if (outcome === 'qualified' && story.score?.total != null) {
      rankable.push({
        id: String(story._id),
        outcome,
        total: story.score.total,
        confidence: story.score.confidence ?? 'low',
        tier: (story.tier ?? 5) as GeographyTier,
        isUpdate: story.relation === 'same_development_new_info',
      });
    }
  }
  for (const id of stats.cluster?.suppressedStoryIds ?? []) {
    const story = candidates.find((s) => String(s._id) === id);
    if (!story) {
      outcomes.push({
        storyId: new Types.ObjectId(id),
        outcome: 'suppressed_repeat',
        detail: 'repeat or skipped development',
      });
    }
  }

  const ranked = rankShortlist(rankable, config.shortlistMax);
  const shortlist = ranked.map((c, i) => ({
    storyId: c.id,
    rank: i + 1,
    score: c.total,
    isUpdate: c.isUpdate,
  }));
  for (const item of shortlist) {
    // Idempotent: a retried finalize never records the same recommendation twice.
    await Story.updateOne(
      { _id: item.storyId, 'recommendations.runKey': { $ne: runKey } },
      {
        $push: {
          recommendations: {
            runKey,
            rank: item.rank,
            score: item.score,
            isUpdate: item.isUpdate,
            at: now,
          },
        },
        $set: { lastRecommendedAt: now },
      },
    );
  }

  const count = (o: CandidateOutcome) => outcomes.filter((x) => x.outcome === o).length;
  const funnel: RunFunnel = {
    ...emptyFunnel(),
    searchQueries: stats.discover?.searchQueries ?? 0,
    searchFailures: stats.discover?.searchFailures ?? 0,
    discovered: stats.discover?.discovered ?? 0,
    newArticles: stats.discover?.newArticles ?? 0,
    revisited: stats.revisit?.revisited ?? 0,
    changed:
      (stats.revisit?.cosmetic ?? 0) +
      (stats.revisit?.updatedReporting ?? 0) +
      (stats.revisit?.newDevelopments ?? 0),
    extractionFailures: stats.extract?.extractionFailures ?? 0,
    inScope: stats.triage?.inScope ?? 0,
    candidates: candidates.length,
    // Classified by an evaluation this run (repeats suppressed at clustering were never evaluated).
    evaluated:
      count('qualified') +
      count('below_threshold') +
      count('gate_hold') +
      count('gate_reject') +
      outcomes.filter(
        (o) => o.outcome === 'suppressed_repeat' && candidates.some((s) => s._id.equals(o.storyId)),
      ).length,
    evaluationFailures: count('evaluation_failed'),
    deferredLate: count('deferred_late'),
    gateHolds: count('gate_hold'),
    gateRejects: count('gate_reject'),
    gateRejectsByGate,
    suppressedRepeats: count('suppressed_repeat'),
    belowThreshold: count('below_threshold'),
    qualified: count('qualified'),
    shortlisted: shortlist.length,
    waitingToExtract: stats.extract?.waiting ?? 0,
    waitingToCluster: stats.cluster?.overCap ?? 0,
    expiredBeforeExtract: stats.extract?.expired ?? 0,
    expiredBeforeCluster: stats.cluster?.expired ?? 0,
    expiredBeforeEvaluation: stats.cluster?.expiredStories ?? 0,
  };
  const shortfallReasons = deriveShortfallReasons(funnel, config.shortlistTargetMin);
  const shortlistIds = shortlist.map(
    (s) => candidates.find((c) => String(c._id) === s.storyId)!._id,
  );
  return { shortlist, funnel, shortfallReasons, outcomes, shortlistIds };
}

/** Closes the candidate set and finishes the run with every candidate's outcome. */
export async function finalizeRun(input: {
  runKey: string;
  owner: string;
  deps: DiscoveryDeps;
}): Promise<FinalizeResult> {
  const { runKey, owner, deps } = input;
  const now = deps.now();
  await closeCandidateSet(runKey, now);
  const ranked = await rankRun(runKey, deps, now);
  await completeRun({
    runKey,
    owner,
    now,
    funnel: ranked.funnel,
    shortlist: ranked.shortlist.map((s, i) => ({ ...s, storyId: ranked.shortlistIds[i]! })),
    outcomes: ranked.outcomes,
    shortfallReasons: ranked.shortfallReasons,
  });
  return {
    shortlist: ranked.shortlist,
    funnel: ranked.funnel,
    shortfallReasons: ranked.shortfallReasons,
  };
}

/**
 * Ranks a completed run again after its assessments were recovered (ADR-046), by the same rules
 * as `finalizeRun` and from stored evaluations only. The run keeps its key, its errors and its
 * stage statistics; only its outcomes, funnel, shortlist and shortfall are replaced, and only
 * while it is still completed. Returns null when the run isn't (nothing is written).
 */
export async function rerankCompletedRun(input: {
  runKey: string;
  deps: DiscoveryDeps;
}): Promise<FinalizeResult | null> {
  const { WorkflowRun } = await getModels();
  const run = await getRun(input.runKey);
  if (run?.status !== 'completed') return null;
  const ranked = await rankRun(input.runKey, input.deps, input.deps.now());
  const written = await WorkflowRun.updateOne(
    { runKey: input.runKey, status: 'completed' },
    {
      $set: {
        funnel: ranked.funnel,
        shortlist: ranked.shortlist.map((s, i) => ({ ...s, storyId: ranked.shortlistIds[i]! })),
        outcomes: ranked.outcomes,
        shortfallReasons: ranked.shortfallReasons,
      },
    },
  );
  if (written.matchedCount !== 1) return null;
  return {
    shortlist: ranked.shortlist,
    funnel: ranked.funnel,
    shortfallReasons: ranked.shortfallReasons,
  };
}
