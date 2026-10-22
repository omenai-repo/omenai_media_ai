import {
  emptyFunnel,
  reviewReason,
  selectRepresentativeImage,
  type RunFunnel,
  type ShortfallReason,
} from '@repo/shared';
import { Types } from 'mongoose';

import { getModels } from '../db/models.js';
import { isUsableImageUrl } from '../discovery/images.js';
import { countRunEvaluations } from '../discovery/runs.js';
import type { SourceArticleDoc } from '../db/models/source-article.js';
import type { StoryDoc } from '../db/models/story.js';
import type { WorkflowRunDoc } from '../db/models/workflow-run.js';
import { NotFoundError } from '../errors.js';
import type {
  ImageDto,
  ReviewedStoryDto,
  RunProgressDto,
  RunDetailDto,
  RunSummaryDto,
  SourceDto,
  StoryCardDto,
  StoryDetailDto,
  UsageRowDto,
} from './dto.js';

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** Re-checks the stored URL, so a bad record can never reach an <img> tag. */
function toImage(article: Pick<SourceArticleDoc, 'image' | 'publisher' | 'url'>): ImageDto | null {
  return article.image?.url && isUsableImageUrl(article.image.url)
    ? {
        url: article.image.url,
        alt: article.image.alt ?? null,
        publisher: article.publisher,
        pageUrl: article.url,
      }
    : null;
}

function toCard(story: StoryDoc, publishers: string[], image: ImageDto | null): StoryCardDto {
  return {
    id: String(story._id),
    headline: story.headline,
    summary: story.summary ?? '',
    whyItMatters: story.whyItMatters ?? '',
    angle: story.angle ?? '',
    whyNow: story.whyNow ?? '',
    primaryPillar: story.primaryPillar ?? null,
    subcategories: story.subcategories ?? [],
    crossCuttingTags: story.crossCuttingTags ?? [],
    geography: (story.geography ?? []).map((g) => ({
      country: g.country,
      city: g.city ?? null,
      region: g.region,
    })),
    tier: story.tier ?? 5,
    score: {
      total: story.score?.total ?? null,
      band: story.score?.band ?? null,
      confidence: story.score?.confidence ?? null,
    },
    outcome: story.evaluation?.outcome ?? null,
    recommendedAction: story.recommendedAction ?? null,
    timeliness: story.timeliness ?? null,
    noveltyStatus: story.noveltyStatus ?? null,
    relation: story.relation ?? 'new',
    editorialState: story.editorialState ?? 'none',
    sourceCount: story.sourceArticleIds.length,
    publishers,
    image,
    firstSeenRunKey: story.firstSeenRunKey,
    lastRecommendedAt: iso(story.lastRecommendedAt),
    createdAt: iso(story.createdAt),
  };
}

/** Publisher names and a representative image per story, in one query for a list of stories. */
async function articleContext(
  stories: StoryDoc[],
): Promise<Map<string, { publishers: string[]; image: ImageDto | null }>> {
  const { SourceArticle } = await getModels();
  const ids = stories.flatMap((s) => s.sourceArticleIds);
  const articles = await SourceArticle.find(
    { _id: { $in: ids } },
    {
      publisher: 1,
      url: 1,
      canonicalUrl: 1,
      image: 1,
      sourceQuality: 1,
      extractionStatus: 1,
      publishedAt: 1,
    },
  ).lean();
  const byId = new Map(articles.map((a) => [String(a._id), a]));
  return new Map(
    stories.map((story) => {
      const own = story.sourceArticleIds
        .map((id) => byId.get(String(id)))
        .filter((a): a is NonNullable<typeof a> => Boolean(a));
      const chosen = selectRepresentativeImage(
        own.map((a) => ({
          image: toImage(a),
          sourceQuality: a.sourceQuality ?? 'unknown',
          extractionStatus: a.extractionStatus ?? 'pending',
          publishedAt: a.publishedAt ?? null,
          canonicalUrl: a.canonicalUrl,
        })),
      );
      return [
        String(story._id),
        { publishers: [...new Set(own.map((a) => a.publisher))], image: chosen },
      ];
    }),
  );
}

async function cards(stories: StoryDoc[]): Promise<StoryCardDto[]> {
  const context = await articleContext(stories);
  return stories.map((s) => {
    const c = context.get(String(s._id));
    return toCard(s, c?.publishers ?? [], c?.image ?? null);
  });
}

export function toRunSummary(run: WorkflowRunDoc): RunSummaryDto {
  const funnel = (run.funnel ?? emptyFunnel()) as RunFunnel;
  return {
    runKey: run.runKey,
    trigger: run.trigger,
    status: run.status ?? 'queued',
    stage: run.stage ?? 'queued',
    createdAt: iso(run.createdAt),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.completedAt),
    candidates: funnel.candidates ?? 0,
    qualified: funnel.qualified ?? 0,
    shortlisted: run.shortlist?.length ?? 0,
    articlesFound: funnel.discovered ?? 0,
    storiesReviewed: run.outcomes?.length ?? 0,
    sourceFailures: (funnel.searchFailures ?? 0) + (funnel.extractionFailures ?? 0),
    evaluationFailures: funnel.evaluationFailures ?? 0,
    shortfallReasons: (run.shortfallReasons ?? []) as ShortfallReason[],
    progress: null,
    recovery: toRunRecovery(run),
  };
}

function toRunRecovery(run: WorkflowRunDoc): RunSummaryDto['recovery'] {
  const recovery = run.recovery;
  if (!recovery) return null;
  const counts = (recovery.counts ?? {}) as {
    assessed?: number;
    eligibleAtStart?: number;
    remainingEligible?: number;
  };
  return {
    status: recovery.status,
    startedAt: iso(recovery.startedAt),
    updatedAt: iso(recovery.updatedAt),
    completedAt: iso(recovery.completedAt),
    assessed: counts.assessed ?? 0,
    remaining:
      counts.remainingEligible ??
      Math.max(0, (counts.eligibleAtStart ?? 0) - (counts.assessed ?? 0)),
    note: recovery.note ?? null,
  };
}

/** How far an unfinished run has got, from its stored stage results. */
export async function runProgress(run: WorkflowRunDoc): Promise<RunProgressDto | null> {
  if (run.status !== 'running' && run.status !== 'queued') return null;
  const stats = (run.stageStats ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const found = Number(stats.discover?.discovered ?? 0);
  const ids = run.candidateStoryIds ?? [];
  if (run.stage === 'evaluate' && ids.length) {
    const { finished } = await countRunEvaluations(run.runKey, ids);
    return { stage: 'evaluate', done: finished, total: ids.length, articlesFound: found };
  }
  return { stage: run.stage ?? 'queued', done: null, total: null, articlesFound: found };
}

export async function toRunSummaryWithProgress(run: WorkflowRunDoc): Promise<RunSummaryDto> {
  return { ...toRunSummary(run), progress: await runProgress(run) };
}

export async function listRuns(limit = 20): Promise<RunSummaryDto[]> {
  const { WorkflowRun } = await getModels();
  const runs = await WorkflowRun.find().sort({ createdAt: -1 }).limit(limit).lean();
  return runs.map(toRunSummary);
}

/**
 * The newsroom view: a completed run's shortlist in rank order. Defaults to the most recently
 * completed run; `runKey` selects an earlier one.
 */
export async function getNewsroom(runKey?: string): Promise<{
  run: RunSummaryDto | null;
  shortlist: StoryCardDto[];
  reviewed: ReviewedStoryDto[];
  recentRuns: RunSummaryDto[];
  /** On the latest view: a run started after the shown edition that hasn't completed. */
  newerRun: RunSummaryDto | null;
}> {
  const { WorkflowRun, Story } = await getModels();
  const [recent, newest] = await Promise.all([
    WorkflowRun.find({ status: 'completed' }).sort({ completedAt: -1 }).limit(14).lean(),
    runKey ? null : WorkflowRun.findOne().sort({ createdAt: -1 }).lean(),
  ]);
  const run = runKey
    ? await WorkflowRun.findOne({ runKey, status: 'completed' }).lean()
    : (recent[0] ?? null);
  const newerRun =
    newest && newest.status !== 'completed' && newest.runKey !== run?.runKey
      ? await toRunSummaryWithProgress(newest)
      : null;
  if (!run)
    return {
      run: null,
      shortlist: [],
      reviewed: [],
      recentRuns: recent.map(toRunSummary),
      newerRun,
    };

  const entries = run.shortlist ?? [];
  const ids = entries
    .map((e) => e.storyId)
    .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);
  const stories = await Story.find({ _id: { $in: ids } }).lean();
  const byId = new Map((await cards(stories)).map((c) => [c.id, c]));
  const shortlist: StoryCardDto[] = [];
  for (const entry of entries) {
    const card = byId.get(String(entry.storyId));
    if (card) shortlist.push({ ...card, rank: entry.rank ?? 0, isUpdate: entry.isUpdate ?? false });
  }
  shortlist.sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  return {
    run: toRunSummary(run),
    shortlist,
    reviewed: await reviewedStories(run, new Set(shortlist.map((c) => c.id))),
    recentRuns: recent.map(toRunSummary),
    newerRun,
  };
}

/** Every other story the run decided on, with a plain-language reason built from stored facts. */
async function reviewedStories(
  run: WorkflowRunDoc,
  shortlisted: Set<string>,
): Promise<ReviewedStoryDto[]> {
  const { Story } = await getModels();
  const outcomes = (run.outcomes ?? []).filter(
    (o) => o.storyId && !shortlisted.has(String(o.storyId)),
  );
  const ids = outcomes
    .map((o) => o.storyId)
    .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);
  const stories = await Story.find(
    { _id: { $in: ids } },
    { headline: 1, score: 1, gates: 1 },
  ).lean();
  const byId = new Map(stories.map((s) => [String(s._id), s]));
  return outcomes.map((o) => {
    const story = byId.get(String(o.storyId));
    const score = story?.score?.total ?? null;
    return {
      id: String(o.storyId),
      headline: story?.headline ?? '(story removed)',
      outcome: o.outcome ?? 'unknown',
      score,
      reason: reviewReason({
        outcome: o.outcome ?? null,
        failingChecks: (story?.gates?.results ?? [])
          .filter((g) => g.outcome !== 'pass')
          .map((g) => g.gate),
        score,
        recommended: false,
      }),
    };
  });
}

/** The shared reading list, newest saves first, with who saved each story and when. */
export async function listSavedStories(): Promise<StoryCardDto[]> {
  const { Story, AuthUser } = await getModels();
  const stories = await Story.find({ editorialState: 'saved' }).limit(200).lean();
  const lastSave = (story: StoryDoc) =>
    (story.decisions ?? []).filter((d) => d.action === 'saved').at(-1) ?? null;
  const userIds = [
    ...new Set(stories.map((s) => lastSave(s)?.userId).filter((u): u is string => Boolean(u))),
  ].filter((u) => Types.ObjectId.isValid(u));
  const users = await AuthUser.find({ _id: { $in: userIds } }, { name: 1, email: 1 }).lean();
  const names = new Map(users.map((u) => [String(u._id), u.name || u.email]));
  const result = (await cards(stories)).map((card, i) => {
    const save = lastSave(stories[i]!);
    return {
      ...card,
      saved: save ? { by: names.get(save.userId) ?? 'A colleague', at: iso(save.at) ?? '' } : null,
    };
  });
  return result.sort((a, b) => (b.saved?.at ?? '').localeCompare(a.saved?.at ?? ''));
}

function toSource(article: SourceArticleDoc): SourceDto {
  return {
    id: String(article._id),
    url: article.url,
    publisher: article.publisher,
    headline: article.originalHeadline,
    publishedAt: iso(article.publishedAt),
    retrievedAt: iso(article.retrievedAt),
    sourceQuality: article.sourceQuality ?? 'unknown',
    extractionStatus: article.extractionStatus ?? 'pending',
    origin: article.origin,
    image: toImage(article),
  };
}

export async function getStoryDetail(id: string): Promise<StoryDetailDto> {
  if (!Types.ObjectId.isValid(id)) throw new NotFoundError('Story not found.');
  const { Story, SourceArticle, AuthUser } = await getModels();
  const story = await Story.findById(id).lean();
  if (!story) throw new NotFoundError('Story not found.');

  const [articles, parent, developments] = await Promise.all([
    SourceArticle.find({ _id: { $in: story.sourceArticleIds } })
      .sort({ publishedAt: -1 })
      .lean(),
    story.parentStoryId
      ? Story.findById(story.parentStoryId, { headline: 1, editorialState: 1 }).lean()
      : null,
    Story.find({ parentStoryId: story._id }, { headline: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .lean(),
  ]);
  const userIds = [...new Set((story.decisions ?? []).map((d) => d.userId))].filter((u) =>
    Types.ObjectId.isValid(u),
  );
  const users = await AuthUser.find({ _id: { $in: userIds } }, { name: 1, email: 1 }).lean();
  const names = new Map(users.map((u) => [String(u._id), u.name || u.email]));

  return {
    ...toCard(
      story,
      [...new Set(articles.map((a) => a.publisher))],
      selectRepresentativeImage(
        articles.map((a) => ({
          image: toImage(a),
          sourceQuality: a.sourceQuality ?? 'unknown',
          extractionStatus: a.extractionStatus ?? 'pending',
          publishedAt: a.publishedAt ?? null,
          canonicalUrl: a.canonicalUrl,
        })),
      ),
    ),
    whatHappened: story.whatHappened ?? '',
    editorialTest: {
      canAnswer: story.editorialTest?.canAnswer ?? false,
      answer: story.editorialTest?.answer ?? '',
    },
    culturalConnections: story.culturalConnections ?? [],
    entities: story.entities ?? [],
    formatPotential: (story.formatPotential ?? []).map((f) => ({
      format: f.format ?? '',
      rationale: f.rationale ?? '',
    })),
    verificationNeeds: story.verificationNeeds ?? [],
    peopleToApproach: (story.peopleToApproach ?? []).map((p) => ({
      name: p.name ?? '',
      role: p.role ?? '',
      basis: p.basis ?? '',
    })),
    visualOpportunities: story.visualOpportunities ?? [],
    dimensions: (story.score?.dimensions ?? []).map((d) => ({
      dimension: d.dimension,
      score: d.score,
      rationale: d.rationale,
    })),
    gates: (story.gates?.results ?? []).map((g) => ({
      gate: g.gate,
      outcome: g.outcome,
      reason: g.reason,
    })),
    sources: articles.map(toSource),
    parent: parent
      ? {
          id: String(parent._id),
          headline: parent.headline,
          editorialState: parent.editorialState ?? 'none',
        }
      : null,
    developments: developments.map((d) => ({
      id: String(d._id),
      headline: d.headline,
      createdAt: iso(d.createdAt as Date | undefined),
    })),
    decisions: (story.decisions ?? [])
      .map((d) => ({
        action: d.action,
        userName: names.get(d.userId) ?? 'Former user',
        reason: d.reason ?? null,
        at: iso(d.at) ?? '',
      }))
      .reverse(),
    recommendations: (story.recommendations ?? []).map((r) => ({
      runKey: r.runKey,
      rank: r.rank,
      score: r.score,
      isUpdate: r.isUpdate,
      at: iso(r.at) ?? '',
    })),
    evaluation: {
      status: story.evaluation?.status ?? 'pending',
      model: story.evaluation?.model ?? null,
      escalated: story.evaluation?.escalated ?? false,
      evaluatedAt: iso(story.evaluation?.evaluatedAt),
      error: story.evaluation?.error ?? null,
      runKey: story.evaluation?.runKey ?? null,
    },
  };
}

async function usageRows(match: Record<string, unknown>): Promise<UsageRowDto[]> {
  const { AiUsage } = await getModels();
  const rows = await AiUsage.aggregate<{
    _id: { provider: string; operation: string; model: string | null; simulated: boolean };
    calls: number;
    errors: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    units: number;
    unreportedCalls: number;
  }>([
    { $match: match },
    {
      $group: {
        _id: {
          provider: '$provider',
          operation: '$operation',
          model: '$model',
          simulated: { $ifNull: ['$simulated', false] },
        },
        calls: { $sum: 1 },
        errors: { $sum: { $cond: [{ $eq: ['$outcome', 'error'] }, 1, 0] } },
        inputTokens: { $sum: '$inputTokens' },
        outputTokens: { $sum: '$outputTokens' },
        cachedInputTokens: { $sum: '$cachedInputTokens' },
        cacheWriteTokens: { $sum: { $ifNull: ['$cacheWriteTokens', 0] } },
        reasoningTokens: { $sum: '$reasoningTokens' },
        units: { $sum: { $ifNull: ['$units', 0] } },
        // Successful search/extract calls whose response carried no credit count.
        unreportedCalls: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $in: ['$kind', ['search', 'extract']] },
                  { $eq: ['$outcome', 'ok'] },
                  { $eq: [{ $ifNull: ['$units', null] }, null] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $sort: { '_id.provider': 1, '_id.operation': 1 } },
  ]);
  return rows.map((r) => ({
    provider: r._id.provider,
    operation: r._id.operation,
    model: r._id.model,
    calls: r.calls,
    errors: r.errors,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedInputTokens: r.cachedInputTokens ?? 0,
    cacheWriteTokens: r.cacheWriteTokens ?? 0,
    reasoningTokens: r.reasoningTokens,
    units: r.units,
    unreportedCalls: r.unreportedCalls,
    simulated: r._id.simulated,
  }));
}

/** Raw provider usage over the last `days` days (all operations, including research and drafts). */
export async function usageSince(days: number, now: Date = new Date()): Promise<UsageRowDto[]> {
  return usageRows({ createdAt: { $gte: new Date(now.getTime() - days * 86_400_000) } });
}

export async function getRunDetail(runKey: string): Promise<RunDetailDto> {
  const { WorkflowRun, Story, Task } = await getModels();
  const run = await WorkflowRun.findOne({ runKey }).lean();
  if (!run) throw new NotFoundError('Run not found.');

  const outcomeIds = (run.outcomes ?? [])
    .map((o) => o.storyId)
    .filter((id): id is Types.ObjectId => id instanceof Types.ObjectId);
  const [stories, failedTasks, usage] = await Promise.all([
    Story.find({ _id: { $in: outcomeIds } }, { headline: 1, score: 1, gates: 1 }).lean(),
    Task.find({ runKey, status: 'failed' }).sort({ updatedAt: -1 }).limit(50).lean(),
    usageRows({ runKey }),
  ]);
  const byId = new Map(stories.map((s) => [String(s._id), s]));
  const recommended = new Set((run.shortlist ?? []).map((e) => String(e.storyId)));

  return {
    ...(await toRunSummaryWithProgress(run)),
    requestedBy: run.requestedBy ?? null,
    funnel: (run.funnel ?? null) as RunFunnel | null,
    deadlines: {
      soft: iso(run.deadlines?.soft),
      extension: iso(run.deadlines?.extension),
      hard: iso(run.deadlines?.hard),
    },
    candidateSetClosedAt: iso(run.candidateSetClosedAt),
    outcomes: (run.outcomes ?? []).map((o) => {
      const story = byId.get(String(o.storyId));
      const score = story?.score?.total ?? null;
      return {
        storyId: String(o.storyId),
        headline: story?.headline ?? '(story removed)',
        outcome: o.outcome ?? 'unknown',
        detail: o.detail ?? '',
        reason: reviewReason({
          outcome: o.outcome ?? null,
          failingChecks: (story?.gates?.results ?? [])
            .filter((g) => g.outcome !== 'pass')
            .map((g) => g.gate),
          score,
          recommended: recommended.has(String(o.storyId)),
        }),
        recommended: recommended.has(String(o.storyId)),
        score,
      };
    }),
    errors: (run.runErrors ?? []).map((e) => ({
      stage: e.stage ?? '',
      message: e.message ?? '',
      at: iso(e.at),
    })),
    failedTasks: failedTasks.map((t) => ({
      key: t.key,
      kind: t.kind,
      attempts: t.attempts ?? 0,
      lastError: t.lastError ?? null,
      updatedAt: iso(t.updatedAt as Date | undefined),
    })),
    usage,
  };
}
